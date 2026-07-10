// netlify/functions/verify-order.js
// Called after Stripe redirects the customer back. Confirms the payment actually
// succeeded (never trust the redirect alone), then records the order and updates
// stock in Supabase — but only once per session, even if called twice.

const Stripe = require("stripe");

const SUPABASE_URL = "https://njlrcamdlghcvzkwpbff.supabase.co";
const SUPABASE_ANON_KEY = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Im5qbHJjYW1kbGdoY3Z6a3dwYmZmIiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODM1Nzg5MjIsImV4cCI6MjA5OTE1NDkyMn0.ul4nyNg2Lbwl3LKJ2qW6ogOw_xkgNYRwuAApOHO8CKI";

async function sbGet(key) {
  const res = await fetch(`${SUPABASE_URL}/rest/v1/app_data?select=value&key=eq.${key}`, {
    headers: { apikey: SUPABASE_ANON_KEY, Authorization: `Bearer ${SUPABASE_ANON_KEY}` },
  });
  const rows = await res.json();
  return rows[0] ? rows[0].value : null;
}
async function sbSet(key, value) {
  await fetch(`${SUPABASE_URL}/rest/v1/app_data?on_conflict=key`, {
    method: "POST",
    headers: {
      apikey: SUPABASE_ANON_KEY,
      Authorization: `Bearer ${SUPABASE_ANON_KEY}`,
      "Content-Type": "application/json",
      Prefer: "resolution=merge-duplicates,return=minimal",
    },
    body: JSON.stringify([{ key, value }]),
  });
}
const genOrderNo = () => "PR-" + Math.floor(100000 + Math.random() * 900000);

exports.handler = async (event) => {
  try {
    const sessionId = event.queryStringParameters && event.queryStringParameters.session_id;
    if (!sessionId) return { statusCode: 400, body: JSON.stringify({ error: "Missing session_id." }) };

    const stripe = Stripe(process.env.STRIPE_SECRET_KEY);
    const session = await stripe.checkout.sessions.retrieve(sessionId, { expand: ["shipping_details"] });

    if (session.payment_status !== "paid") {
      return { statusCode: 200, body: JSON.stringify({ paid: false }) };
    }

    // Idempotency: don't double-record if the customer refreshes the confirmation page.
    const existingOrders = (await sbGet("pr_orders")) || [];
    const already = existingOrders.find((o) => o.stripeSessionId === sessionId);
    if (already) {
      return { statusCode: 200, body: JSON.stringify({ paid: true, order: already }) };
    }

    const cartItems = JSON.parse(session.metadata.cart || "[]");
    const products = (await sbGet("pr_products")) || [];

    const orderItems = cartItems.map((c) => {
      const p = products.find((pp) => pp.id === c.id);
      return { id: c.id, name: p ? p.name : c.id, price: p ? p.price : 0, qty: c.qty };
    });

    const shipping = session.shipping_details && session.shipping_details.address
      ? {
          address: session.shipping_details.address.line1 || "",
          city: session.shipping_details.address.city || "",
          state: session.shipping_details.address.state || "",
          zip: session.shipping_details.address.postal_code || "",
        }
      : { address: "", city: "", state: "", zip: "" };

    const order = {
      id: "ord_" + sessionId.slice(-16),
      orderNo: genOrderNo(),
      memberEmail: session.metadata.memberEmail || session.customer_details?.email || "",
      memberName: session.metadata.memberName || "",
      items: orderItems,
      total: (session.amount_total || 0) / 100,
      status: "Received",
      shipping,
      cardLast4: "stripe",
      createdAt: Date.now(),
      stripeSessionId: sessionId,
    };

    const updatedProducts = products.map((p) => {
      const inCart = cartItems.find((c) => c.id === p.id);
      return inCart ? { ...p, stock: Math.max(0, p.stock - inCart.qty) } : p;
    });

    await Promise.all([
      sbSet("pr_orders", [order, ...existingOrders]),
      sbSet("pr_products", updatedProducts),
    ]);

    return { statusCode: 200, body: JSON.stringify({ paid: true, order }) };
  } catch (err) {
    console.error(err);
    return { statusCode: 500, body: JSON.stringify({ error: err.message }) };
  }
};
