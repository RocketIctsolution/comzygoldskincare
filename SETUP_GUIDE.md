# Comzygold — Firebase + Paystack (Vercel webhook) Setup Guide

## 0. Do this first: rotate your Paystack secret key

You pasted `sk_test_d9df42301b069811eb6557dde09ff265355d56f9` into a chat. Go to
**Paystack Dashboard → Settings → API Keys & Webhooks → Regenerate** and get a
fresh test secret key before using any of this. Same discipline forever with
the live secret key later: it only ever lives in Vercel's encrypted
environment variables, never in a chat, a file you commit, or a frontend
`<script>`.

---

## 1. What you were given

```
index.html                    → the storefront (rename from comzygold-skincare.html)
admin.html                     → the admin dashboard
firestore.rules                → database security rules
firebase.json                   → hosting + firestore config (no Cloud Functions)
vercel-webhook/                 → a separate small project — the payment webhook
  ├─ api/paystack-webhook.js    → the ONLY file that ever touches your secret keys
  ├─ package.json
  ├─ .env.local.example
  └─ .gitignore
SETUP_GUIDE.md                  → this file
```

Two separate deployments, nothing shares code between them:

- **`index.html` + `admin.html`** → Firebase Hosting (or anywhere — they're plain static files).
- **`vercel-webhook/`** → its own tiny project, deployed to Vercel.

Nothing in `index.html` or `admin.html` needs to change for this setup —
they already write orders to Firestore and open the Paystack popup with your
public key. Only the backend that verifies payment changes.

---

## Part A — Deploy the webhook to Vercel

### A1. Get a Firebase service account key

This is what lets the webhook (running outside Firebase) write to your
Firestore database with admin rights.

Firebase Console → ⚙️ Project Settings → **Service Accounts** →
**Generate new private key** → a JSON file downloads. You'll need three
values out of it in a moment: `project_id`, `client_email`, `private_key`.

Keep this JSON file somewhere private — never commit it to a repo.

### A2. Install the Vercel CLI and log in

```bash
npm install -g vercel
vercel login
```

### A3. Deploy the webhook project

```bash
cd vercel-webhook
npm install
vercel
```

Follow the prompts (link to a new project, accept defaults). This gives you
a preview URL — you'll set env vars and redeploy to production next.

### A4. Set environment variables

In the Vercel dashboard for this project → **Settings → Environment
Variables**, add:

| Name | Value |
|---|---|
| `PAYSTACK_SECRET_KEY` | your regenerated `sk_test_...` key |
| `FIREBASE_PROJECT_ID` | `comzygold` |
| `FIREBASE_CLIENT_EMAIL` | `client_email` from the service account JSON |
| `FIREBASE_PRIVATE_KEY` | `private_key` from the service account JSON, **including** the `-----BEGIN PRIVATE KEY-----` / `-----END PRIVATE KEY-----` lines |

For `FIREBASE_PRIVATE_KEY`: paste it exactly as it appears in the JSON file
(with the literal `\n` sequences) — the function code converts those back
into real newlines automatically.

Set all three for **Production** (and Preview if you want to test there too).

### A5. Redeploy so the env vars take effect

```bash
vercel --prod
```

Copy the production URL it gives you, e.g.:

```
https://comzygold-webhook.vercel.app/api/paystack-webhook
```

### A6. Point Paystack at it

Paystack Dashboard → Settings → API Keys & Webhooks → **Webhook URL** →
paste the URL from A5 → Save.

---

## Part B — Deploy the storefront + admin

### B1. Set up Firebase Hosting (optional — you can host these two files anywhere)

```bash
npm install -g firebase-tools
firebase login

mkdir comzygold-site && cd comzygold-site
mkdir public
cp /path/to/index.html public/index.html
cp /path/to/admin.html public/admin.html
cp /path/to/firebase.json .
cp /path/to/firestore.rules .

firebase use --add
# select your "comzygold" project
```

### B2. Deploy Firestore rules

```bash
firebase deploy --only firestore:rules
```

### B3. Deploy hosting

```bash
firebase deploy --only hosting
```

Your site will be live at `https://comzygold.web.app` (storefront) and
`https://comzygold.web.app/admin` (dashboard).

### B4. Create your admin login

Firebase Console → Authentication → Get Started → Sign-in method → enable
**Email/Password** → Users tab → **Add user** → Mrs Comfort's email and a
password. That's what she'll use to sign into `/admin`.

### B5. First login seeds the database

The first time you sign into `/admin`, it automatically writes the 8
starting products into Firestore (only if the `products` collection is
empty), so the storefront and dashboard immediately share real data.

---

## How the payment flow works, end to end

1. Customer checks out on the storefront → browser writes a `pending` order
   straight to Firestore (allowed — see `firestore.rules`).
2. Paystack Inline popup opens using only the **publishable** key.
3. Customer pays. Paystack calls your Vercel webhook server-to-server.
4. The function verifies the request really came from Paystack (HMAC
   signature check using the secret key), then — and only then — marks the
   order `paid`, decrements stock, and writes a `sales` record via the
   Firebase Admin SDK (which bypasses Firestore rules, same as a Cloud
   Function would have).
5. The storefront, which has been listening to that order document the
   whole time, sees `status: "paid"` and shows the confirmation screen.
6. That sale shows up in the admin dashboard in real time.

The browser is never trusted to say "I paid" — only Paystack's
server-verified webhook, running on Vercel, can flip that switch.

---

## Testing it end-to-end (test mode)

1. Complete steps A1–A6 and B1–B5.
2. Open your storefront, add something to the bag, checkout with a test
   email.
3. Use a Paystack test card in the popup (Paystack's docs list current test
   card numbers).
4. Watch the checkout modal — it should flip from "Waiting for payment…" to
   "Payment confirmed!" within a few seconds of paying.
5. Check Vercel → your project → **Logs** to see the webhook fire and
   confirm no errors.
6. Open `/admin` → Sales — the new sale should appear tagged **Online**,
   and the product's stock should have gone down.

---

## Firestore data shapes (for reference)

**products/{id}**
```
name: string
price: number
stock: number
cat: "Face" | "Body"
image: string (URL, optional — falls back to a bundled photo for the 8 seed products)
tag: string (optional, e.g. "Bestseller")
blurb: string (optional)
```

**sales/{id}**
```
productId, productName, qty, price, total, date ("YYYY-MM-DD")
source: "manual" | "online"
orderRef: string (present only for source:"online")
```

**orders/{reference}**
```
reference, name, email, phone, address
items: [{ id, name, price, qty }]
amount: number (Naira)
status: "pending" | "paid"
createdAt, paidAt, amountPaid
```

## Going live later

When you're ready for real payments:
1. Switch `pk_test_...` in `index.html` to your `pk_live_...` key.
2. Update `PAYSTACK_SECRET_KEY` in Vercel to your `sk_live_...` key.
3. Add the webhook URL again under Paystack's **live mode** settings — test
   and live webhooks are configured separately.
