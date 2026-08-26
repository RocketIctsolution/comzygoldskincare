/**
 * COMZYGOLD — Paystack webhook (Vercel Serverless Function)
 *
 * This is the ONLY place the Paystack secret key or the Firebase service
 * account credentials are ever used. All three come from Vercel Environment
 * Variables at runtime — none of them are hardcoded here.
 *
 * Deployed URL will look like:
 *   https://<your-project>.vercel.app/api/paystack-webhook
 * Set that exact URL in Paystack Dashboard -> Settings -> API Keys & Webhooks.
 */

const crypto = require("crypto");
const admin = require("firebase-admin");

// Vercel parses JSON bodies automatically by default. We need the RAW body
// to verify Paystack's signature, so we turn that off here.
module.exports.config = {
  api: { bodyParser: false },
};

function getRawBody(req) {
  return new Promise((resolve, reject) => {
    let data = "";
    req.on("data", (chunk) => (data += chunk));
    req.on("end", () => resolve(data));
    req.on("error", reject);
  });
}

let firebaseApp;
function getDb() {
  if (!firebaseApp) {
    firebaseApp = admin.initializeApp({
      credential: admin.credential.cert({
        projectId: process.env.FIREBASE_PROJECT_ID,
        clientEmail: process.env.FIREBASE_CLIENT_EMAIL,
        // Vercel env vars store newlines as literal "\n" — convert them back.
        privateKey: (process.env.FIREBASE_PRIVATE_KEY || "").replace(/\\n/g, "\n"),
      }),
    });
  }
  return admin.firestore();
}

module.exports = async (req, res) => {
  if (req.method !== "POST") {
    return res.status(405).send("Method not allowed");
  }

  let rawBody;
  try {
    rawBody = await getRawBody(req);
  } catch (err) {
    console.error("Failed to read request body:", err);
    return res.status(400).send("Bad request");
  }

  const secret = process.env.PAYSTACK_SECRET_KEY;
  if (!secret) {
    console.error("PAYSTACK_SECRET_KEY is not set in Vercel env vars.");
    return res.status(500).send("Server misconfigured");
  }

  const hash = crypto.createHmac("sha512", secret).update(rawBody).digest("hex");
  if (hash !== req.headers["x-paystack-signature"]) {
    console.warn("Invalid Paystack signature — rejecting webhook call.");
    return res.status(401).send("Invalid signature");
  }

  let event;
  try {
    event = JSON.parse(rawBody);
  } catch (err) {
    return res.status(400).send("Invalid JSON");
  }

  if (event.event !== "charge.success") {
    return res.status(200).send("ignored");
  }

  try {
    const db = getDb();
    const reference = event.data.reference;
    const amountPaidKobo = event.data.amount;
    const orderRef = db.collection("orders").doc(reference);

    await db.runTransaction(async (tx) => {
      // ---- READS FIRST (Firestore transaction rule) ----
      const orderSnap = await tx.get(orderRef);
      if (!orderSnap.exists) {
        console.warn(`No order found for reference ${reference}`);
        return;
      }
      const order = orderSnap.data();

      if (order.status === "paid") {
        // Already processed (Paystack can retry webhooks) — idempotent no-op.
        return;
      }

      const productRefs = order.items.map((item) =>
        db.collection("products").doc(item.id)
      );
      const productSnaps = await Promise.all(productRefs.map((ref) => tx.get(ref)));

      // ---- WRITES AFTER ALL READS ----
      tx.update(orderRef, {
        status: "paid",
        paidAt: admin.firestore.FieldValue.serverTimestamp(),
        amountPaid: amountPaidKobo / 100,
      });

      order.items.forEach((item, i) => {
        const snap = productSnaps[i];
        if (snap.exists) {
          const currentStock = snap.data().stock || 0;
          tx.update(snap.ref, { stock: Math.max(0, currentStock - item.qty) });
        }

        const saleRef = db.collection("sales").doc();
        tx.set(saleRef, {
          productId: item.id,
          productName: item.name,
          qty: item.qty,
          price: item.price,
          total: item.price * item.qty,
          date: new Date().toISOString().slice(0, 10),
          source: "online",
          orderRef: reference,
          createdAt: admin.firestore.FieldValue.serverTimestamp(),
        });
      });
    });

    return res.status(200).send("ok");
  } catch (err) {
    console.error("paystackWebhook error:", err);
    // Still 200 so Paystack doesn't hammer retries on a bug we need to fix —
    // but it's logged loudly in Vercel's function logs.
    return res.status(200).send("error-logged");
  }
};
