// netlify/functions/bank-transfer-order.js
// Records a "pay by bank transfer" enquiry. No Stripe involved — the customer
// supplies their contact + delivery details, we verify prices/stock server-side,
// record the order as "Awaiting payment", decrement stock, and email the owner.

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

async function sendEnquiryEmail(order) {
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
        subject: `BANK TRANSFER — ${order.orderNo} — $${order.total.toFixed(2)} — ${order.memberName}`,
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
            <p style="font-size:12px;color:#888">Payment by bank transfer.<br/>
            Items will be sent once funds have cleared.<br/>
            Any questions, call 0414790053.</p>

            <div style="margin-top:30px;padding:14px;background:#f6f6f6;border-left:3px solid #C9A15C">
              <p style="margin:0 0 6px;font-size:12px;font-weight:bold;color:#666">FOR YOU — DELETE BEFORE FORWARDING</p>
              <p style="margin:0;font-size:12px;color:#666">
                Contact: ${order.memberEmail} &middot; ${order.phone}<br/>
                Stock has already been reduced for this order. If the customer does not go ahead,
                add the stock back in the Back Office and mark the order Cancelled.
              </p>
            </div>
          </div>
        `,
      }),
    });
  } catch (e) {
    console.error("bank transfer email failed", e); // never block the order on email failure
  }
}

exports.handler = async (event) => {
  if (event.httpMethod !== "POST") {
    return { statusCode: 405, body: "Method not allowed" };
  }

  try {
    const { items, memberEmail, memberName, phone, shipping } = JSON.parse(event.body);

    if (!items || !items.length) {
      return { statusCode: 400, body: JSON.stringify({ error: "Cart is empty." }) };
    }
    if (!memberName || !memberEmail || !phone) {
      return { statusCode: 400, body: JSON.stringify({ error: "Name, email and phone are required." }) };
    }
    if (!shipping || !shipping.address || !shipping.city || !shipping.state || !shipping.zip) {
      return { statusCode: 400, body: JSON.stringify({ error: "Full delivery address is required." }) };
    }

    // Verify prices and stock server-side — never trust what the browser sends.
    const products = (await sbGet("pr_products")) || [];

    const orderItems = [];
    const stockNeeded = {};
    let subtotal = 0;

    for (const item of items) {
      const product = products.find((p) => p.id === item.id);
      if (!product) {
        return { statusCode: 400, body: JSON.stringify({ error: `Product ${item.id} not found.` }) };
      }
      const isBox = item.variant === "box";
      if (isBox && !(product.boxPrice && product.boxPrice > 0)) {
        return { statusCode: 400, body: JSON.stringify({ error: `${product.name} has no box option.` }) };
      }
      const unitPrice = isBox ? Number(product.boxPrice) : product.price;
      const variantLabel = isBox ? (product.boxLabel || "Box") : "Single";
      stockNeeded[item.id] = (stockNeeded[item.id] || 0) + item.qty;
      if (stockNeeded[item.id] > product.stock) {
        return { statusCode: 400, body: JSON.stringify({ error: `Not enough stock for ${product.name}.` }) };
      }
      subtotal += unitPrice * item.qty;
      orderItems.push({
        id: item.id,
        name: product.name,
        variant: item.variant || "single",
        variantLabel,
        price: unitPrice,
        qty: item.qty,
      });
    }

    const DELIVERY_THRESHOLD = 300;
    const DELIVERY_FEE = 10;
    const deliveryFee = subtotal >= DELIVERY_THRESHOLD ? 0 : DELIVERY_FEE;
    const total = subtotal + deliveryFee;

    const order = {
      id: "ord_bt_" + Date.now().toString(36) + Math.random().toString(36).slice(2, 8),
      orderNo: genOrderNo(),
      memberEmail,
      memberName,
      phone,
      items: orderItems,
      deliveryFee,
      total,
      status: "Awaiting payment",
      paymentMethod: "Bank transfer",
      shipping: {
        address: shipping.address || "",
        city: shipping.city || "",
        state: shipping.state || "",
        zip: shipping.zip || "",
      },
      cardLast4: "Bank transfer",
      createdAt: Date.now(),
    };

    const existingOrders = (await sbGet("pr_orders")) || [];

    // Reduce stock straight away, as agreed — the owner re-adds manually if the
    // customer doesn't go ahead.
    const updatedProducts = products.map((p) => {
      const totalQty = items.filter((c) => c.id === p.id).reduce((s, c) => s + c.qty, 0);
      return totalQty > 0 ? { ...p, stock: Math.max(0, p.stock - totalQty) } : p;
    });

    await Promise.all([
      sbSet("pr_orders", [order, ...existingOrders]),
      sbSet("pr_products", updatedProducts),
    ]);

    await sendEnquiryEmail(order);

    return { statusCode: 200, body: JSON.stringify({ ok: true, order }) };
  } catch (err) {
    console.error(err);
    return { statusCode: 500, body: JSON.stringify({ error: err.message }) };
  }
};
