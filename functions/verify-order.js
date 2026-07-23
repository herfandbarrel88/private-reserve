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
      apikey: process.env.SUPABASE_SERVICE_ROLE_KEY,
      Authorization: `Bearer ${process.env.SUPABASE_SERVICE_ROLE_KEY}`,
      "Content-Type": "application/json",
      Prefer: "resolution=merge-duplicates,return=minimal",
    },
    body: JSON.stringify([{ key, value }]),
  });
}
const genOrderNo = () => "PR-" + Math.floor(100000 + Math.random() * 900000);
const OWNER_EMAIL = "herfandbarrel@gmail.com";

async function sendOrderEmail(order) {
  if (!process.env.RESEND_API_KEY) return; // silently skip if not configured yet
  try {
    await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${process.env.RESEND_API_KEY}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        from: "The Private Reserve <onboarding@resend.dev>",
        to: [OWNER_EMAIL],
        subject: `Order ${order.orderNo} — $${order.total.toFixed(2)} — ${order.memberName}`,
        html: `
          <div style="font-family:Arial,Helvetica,sans-serif;max-width:600px;color:#222">
            <h1 style="margin:0 0 4px;font-size:22px;letter-spacing:1px">THE PRIVATE RESERVE</h1>
            <p style="margin:0 0 18px;color:#777;font-size:13px">0414790053</p>
            <hr style="border:none;border-top:1px solid #ddd;margin:0 0 18px"/>
            <p style="font-size:15px">Hi ${order.memberName}, thank you for your order.</p>
            <p style="font-size:13px;color:#555">Order <strong>${order.orderNo}</strong> &middot; ${new Date(order.createdAt).toLocaleDateString("en-AU")}</p>
            <table style="width:100%;border-collapse:collapse;margin:18px 0;font-size:14px">
              ${order.items.map((it) => `
                <tr>
                  <td style="padding:8px 0;border-bottom:1px solid #eee">
                    ${it.qty} &times; ${it.name}${it.variantLabel ? ` <span style="color:#888">(${it.variantLabel})</span>` : ""}
                  </td>
                  <td style="padding:8px 0;border-bottom:1px solid #eee;text-align:right;white-space:nowrap">
                    $${(it.price * it.qty).toFixed(2)}
                  </td>
                </tr>`).join("")}
              <tr>
                <td style="padding:8px 0;border-bottom:1px solid #eee;color:#555">Delivery</td>
                <td style="padding:8px 0;border-bottom:1px solid #eee;text-align:right">${order.deliveryFee > 0 ? "$" + order.deliveryFee.toFixed(2) : "FREE"}</td>
              </tr>
              <tr>
                <td style="padding:12px 0;font-weight:bold;font-size:16px">Total</td>
                <td style="padding:12px 0;text-align:right;font-weight:bold;font-size:16px">$${order.total.toFixed(2)} AUD</td>
              </tr>
            </table>
            <p style="font-size:13px;color:#555;margin-bottom:4px"><strong>Delivery address</strong></p>
            <p style="font-size:14px;margin-top:0">${order.shipping.address}<br/>${order.shipping.city} ${order.shipping.state} ${order.shipping.zip}</p>
            <hr style="border:none;border-top:1px solid #ddd;margin:22px 0 12px"/>
            <p style="font-size:12px;color:#888">Items will be sent once funds have cleared.<br/>
            Any questions, call 0414790053.</p>
            <p style="font-size:11px;color:#bbb;margin-top:24px">Customer contact: ${order.memberEmail}</p>
          </div>
        `,
      }),
    });
  } catch (e) {
    console.error("email notification failed", e); // never block the order on email failure
  }
}

exports.handler = async (event) => {
  try {
    const sessionId = event.queryStringParameters && event.queryStringParameters.session_id;
    if (!sessionId) return { statusCode: 400, body: JSON.stringify({ error: "Missing session_id." }) };

    const stripe = Stripe(process.env.STRIPE_SECRET_KEY);
    const session = await stripe.checkout.sessions.retrieve(sessionId, {
      expand: ["payment_intent.payment_method"],
    });

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
      const isBox = c.variant === "box";
      const price = p ? (isBox ? Number(p.boxPrice) || 0 : p.price) : 0;
      const variantLabel = p && isBox ? (p.boxLabel || "Box") : "Single";
      return { id: c.id, name: p ? p.name : c.id, variant: c.variant || "single", variantLabel, price, qty: c.qty };
    });

    const shipping = session.shipping_details && session.shipping_details.address
      ? {
          address: session.shipping_details.address.line1 || "",
          city: session.shipping_details.address.city || "",
          state: session.shipping_details.address.state || "",
          zip: session.shipping_details.address.postal_code || "",
        }
      : { address: "", city: "", state: "", zip: "" };

    const card = session.payment_intent && session.payment_intent.payment_method && session.payment_intent.payment_method.card;
    const cardLabel = card ? `${card.brand.charAt(0).toUpperCase()}${card.brand.slice(1)} ····${card.last4}` : "Paid via Stripe";

    const order = {
      id: "ord_" + sessionId.slice(-16),
      orderNo: genOrderNo(),
      memberEmail: session.metadata.memberEmail || session.customer_details?.email || "",
      memberName: session.metadata.memberName || "",
      items: orderItems,
      deliveryFee: parseFloat(session.metadata.deliveryFee || "0"),
      total: (session.amount_total || 0) / 100,
      status: "Received",
      shipping,
      cardLast4: cardLabel,
      createdAt: Date.now(),
      stripeSessionId: sessionId,
    };

    const updatedProducts = products.map((p) => {
      const totalQty = cartItems.filter((c) => c.id === p.id).reduce((s, c) => s + c.qty, 0);
      return totalQty > 0 ? { ...p, stock: Math.max(0, p.stock - totalQty) } : p;
    });

    await Promise.all([
      sbSet("pr_orders", [order, ...existingOrders]),
      sbSet("pr_products", updatedProducts),
    ]);

    await sendOrderEmail(order);

    return { statusCode: 200, body: JSON.stringify({ paid: true, order }) };
  } catch (err) {
    console.error(err);
    return { statusCode: 500, body: JSON.stringify({ error: err.message }) };
  }
};
