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
    const itemsHtml = order.items
      .map(
        (it) =>
          `<li>${it.qty} × ${it.name}${it.variantLabel ? ` (${it.variantLabel})` : ""} — $${(it.price * it.qty).toFixed(2)}</li>`
      )
      .join("");
    await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${process.env.RESEND_API_KEY}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        from: "The Private Reserve <onboarding@resend.dev>",
        to: [OWNER_EMAIL],
        subject: `BANK TRANSFER — ${order.orderNo} — $${order.total.toFixed(2)} (awaiting payment)`,
        html: `
          <h2>Bank transfer request — action needed</h2>
          <p>This customer has asked to pay by bank transfer. Contact them to arrange payment.</p>
          <p><strong>${order.orderNo}</strong> — $${order.total.toFixed(2)} AUD</p>
          <h3>Contact details</h3>
          <ul>
            <li>Name: ${order.memberName}</li>
            <li>Email: ${order.memberEmail}</li>
            <li>Phone: ${order.phone}</li>
          </ul>
          <h3>Order</h3>
          <ul>${itemsHtml}</ul>
          <p>Delivery: ${order.deliveryFee > 0 ? "$" + order.deliveryFee.toFixed(2) : "FREE"}</p>
          <p><strong>Total: $${order.total.toFixed(2)} AUD</strong></p>
          <h3>Deliver to</h3>
          <p>${order.shipping.address}, ${order.shipping.city}, ${order.shipping.state} ${order.shipping.zip}</p>
          <p style="color:#888">Stock has already been reduced for this order. If the customer does not
          go ahead, remember to add the stock back in the Back Office.</p>
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
