// netlify/functions/verify-order.js
// Called after Stripe redirects the customer back. Confirms the payment actually
// succeeded (never trust the redirect alone), then records the order and updates
// stock in Supabase — but only once per session, even if called twice.
//
// Sends TWO emails once the order is recorded:
//   1. A tax invoice to the customer
//   2. A short heads-up to the owner
// Neither can block or fail the order.

const Stripe = require("stripe");

const SUPABASE_URL = "https://njlrcamdlghcvzkwpbff.supabase.co";

/* ------------------------------------------------------------------ *
 *  BUSINESS DETAILS — edit these, nothing else
 * ------------------------------------------------------------------ */
const BIZ = {
  tradingName: "The Private Reserve",

  // Legal entity shown in the invoice footer alongside ABN and licences.
  // Must match the entity that actually holds the ABN and the licences.
  legalName: "The Private Reserve",

  phone: "0414790053",

  // Emails are sent from this address. The domain privatereserve.com.au is
  // verified in Resend, so this works for any recipient.
  fromEmail: "office@privatereserve.com.au",
  ownerEmail: "herfandbarrel@gmail.com",

  abn: "49 639 044 205",

  // Not currently printed on the invoice. Kept here so they're easy to add
  // back if required — see the footer block in invoiceHtml().
  tobaccoLicence: "TR25001592",
  liquorLicence: "LIQP770017945",

  // Set to true ONLY if the business is registered for GST.
  //   true  -> header reads "Tax Invoice", GST component is shown
  //   false -> header reads "Invoice", no GST is mentioned
  gstRegistered: true,

  // Public web address of the site. Logo images are loaded from here,
  // so this must be the real live URL with no trailing slash.
  siteUrl: "https://the-private-reserve.netlify.app",
};

// Logo file must sit in the repo root so it resolves at this address.
const LOGO_PR = `${BIZ.siteUrl}/pr-seal-email.png`;

const GOLD = "#C9A15C";
const CHARCOAL = "#161310";

/* ------------------------------------------------------------------ *
 *  Supabase helpers (service role key — bypasses RLS)
 * ------------------------------------------------------------------ */
async function sbGet(key) {
  const res = await fetch(`${SUPABASE_URL}/rest/v1/app_data?select=value&key=eq.${key}`, {
    headers: {
      apikey: process.env.SUPABASE_SERVICE_ROLE_KEY,
      Authorization: `Bearer ${process.env.SUPABASE_SERVICE_ROLE_KEY}`,
    },
  });
  if (!res.ok) {
    const detail = await res.text();
    throw new Error(`Read failed for ${key} (${res.status}): ${detail.slice(0, 200)}`);
  }
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

/* ------------------------------------------------------------------ *
 *  Email building
 * ------------------------------------------------------------------ */

// Customer-supplied text goes into HTML, so it must be escaped.
function esc(s) {
  return String(s == null ? "" : s)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

const money = (n) => "$" + Number(n || 0).toFixed(2);

function orderDate(ts) {
  return new Date(ts).toLocaleDateString("en-AU", {
    day: "numeric",
    month: "long",
    year: "numeric",
  });
}

function itemRows(order) {
  return order.items
    .map(
      (it) => `
      <tr>
        <td style="padding:10px 0;border-bottom:1px solid #e8e4dd;font-size:14px;color:#222">
          ${esc(it.qty)} &times; ${esc(it.name)}${
        it.variantLabel ? ` <span style="color:#8a8279">(${esc(it.variantLabel)})</span>` : ""
      }
        </td>
        <td style="padding:10px 0;border-bottom:1px solid #e8e4dd;text-align:right;white-space:nowrap;font-size:14px;color:#222">
          ${money(it.price * it.qty)}
        </td>
      </tr>`
    )
    .join("");
}

function totalsRows(order) {
  const subtotal = order.items.reduce((s, it) => s + it.price * it.qty, 0);
  const rows = [];

  rows.push(`
    <tr>
      <td style="padding:10px 0;border-bottom:1px solid #e8e4dd;font-size:14px;color:#55504a">Subtotal</td>
      <td style="padding:10px 0;border-bottom:1px solid #e8e4dd;text-align:right;font-size:14px;color:#222">${money(subtotal)}</td>
    </tr>`);

  rows.push(`
    <tr>
      <td style="padding:10px 0;border-bottom:1px solid #e8e4dd;font-size:14px;color:#55504a">Delivery</td>
      <td style="padding:10px 0;border-bottom:1px solid #e8e4dd;text-align:right;font-size:14px;color:#222">${
        order.deliveryFee > 0 ? money(order.deliveryFee) : "FREE"
      }</td>
    </tr>`);

  if (BIZ.gstRegistered) {
    // Australian GST is 1/11th of a GST-inclusive total.
    const gst = order.total / 11;
    rows.push(`
    <tr>
      <td style="padding:10px 0;border-bottom:1px solid #e8e4dd;font-size:13px;color:#8a8279">Includes GST</td>
      <td style="padding:10px 0;border-bottom:1px solid #e8e4dd;text-align:right;font-size:13px;color:#8a8279">${money(gst)}</td>
    </tr>`);
  }

  rows.push(`
    <tr>
      <td style="padding:14px 0 0;font-weight:bold;font-size:17px;color:${CHARCOAL}">Total paid</td>
      <td style="padding:14px 0 0;text-align:right;font-weight:bold;font-size:17px;color:${CHARCOAL}">${money(order.total)} AUD</td>
    </tr>`);

  return rows.join("");
}

function invoiceHtml(order) {
  const heading = BIZ.gstRegistered ? "TAX INVOICE" : "INVOICE";
  const name = order.memberName ? esc(order.memberName) : "there";

  return `<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8"/>
  <meta name="viewport" content="width=device-width,initial-scale=1"/>
  <title>Invoice ${esc(order.orderNo)}</title>
</head>
<body style="margin:0;padding:0;background:#f4f1ec">
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#f4f1ec;padding:24px 12px">
    <tr><td align="center">
      <table role="presentation" width="600" cellpadding="0" cellspacing="0" style="max-width:600px;width:100%;background:#ffffff;border:1px solid #e3ded5">

        <!-- header -->
        <tr>
          <td style="background:${CHARCOAL};padding:28px 30px;text-align:center">
            <img src="${LOGO_PR}" alt="The Private Reserve" width="92" height="92" style="display:inline-block"/>
            <div style="color:${GOLD};font-family:Georgia,'Times New Roman',serif;font-size:19px;letter-spacing:3px;margin-top:14px">
              THE PRIVATE RESERVE
            </div>
          </td>
        </tr>

        <!-- invoice meta -->
        <tr>
          <td style="padding:26px 30px 0;font-family:Arial,Helvetica,sans-serif">
            <div style="font-size:12px;letter-spacing:2px;color:#8a8279;margin-bottom:14px">${heading}</div>
            <p style="font-size:15px;color:#222;margin:0 0 16px">Hi ${name}, thank you for your order.</p>
            <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="font-size:13px;color:#55504a;margin-bottom:6px">
              <tr>
                <td style="padding:2px 0">Order number</td>
                <td style="padding:2px 0;text-align:right;color:#222"><strong>${esc(order.orderNo)}</strong></td>
              </tr>
              <tr>
                <td style="padding:2px 0">Date</td>
                <td style="padding:2px 0;text-align:right;color:#222">${orderDate(order.createdAt)}</td>
              </tr>
              <tr>
                <td style="padding:2px 0">Payment</td>
                <td style="padding:2px 0;text-align:right;color:#222">${esc(order.cardLast4)}</td>
              </tr>
            </table>
          </td>
        </tr>

        <!-- items -->
        <tr>
          <td style="padding:12px 30px 0;font-family:Arial,Helvetica,sans-serif">
            <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="border-collapse:collapse">
              ${itemRows(order)}
              ${totalsRows(order)}
            </table>
          </td>
        </tr>

        <!-- delivery -->
        <tr>
          <td style="padding:26px 30px 0;font-family:Arial,Helvetica,sans-serif">
            <div style="font-size:12px;letter-spacing:2px;color:#8a8279;margin-bottom:8px">SHIP TO</div>
            <p style="font-size:14px;color:#222;margin:0;line-height:1.6">
              ${order.memberName ? esc(order.memberName) + "<br/>" : ""}
              ${esc(order.shipping.address)}<br/>
              ${esc(order.shipping.city)} ${esc(order.shipping.state)} ${esc(order.shipping.zip)}
            </p>
            <p style="font-size:13px;color:#55504a;margin:10px 0 0;line-height:1.7">
              ${order.memberEmail ? esc(order.memberEmail) + "<br/>" : ""}
              ${order.memberPhone ? esc(order.memberPhone) : ""}
            </p>
          </td>
        </tr>

        <!-- note -->
        <tr>
          <td style="padding:24px 30px 0;font-family:Arial,Helvetica,sans-serif">
            <p style="font-size:13px;color:#55504a;margin:0;line-height:1.6">
              Items will be sent once funds have cleared. Any questions, call
              <a href="tel:${BIZ.phone}" style="color:#8a6d33">${BIZ.phone}</a>
              or reply to this email.
            </p>
          </td>
        </tr>

        <!-- footer -->
        <tr>
          <td style="padding:24px 30px 28px;font-family:Arial,Helvetica,sans-serif">
            <div style="border-top:1px solid #e3ded5;padding-top:16px;font-size:11px;color:#8a8279;line-height:1.8">
              <strong style="color:#55504a">${esc(BIZ.legalName)}</strong><br/>
              ABN ${BIZ.abn}
            </div>
            <div style="margin-top:14px;font-size:11px;color:#a09890;line-height:1.7">
              It is against the law to sell or supply tobacco or alcohol to anyone under 18.
            </div>
          </td>
        </tr>

      </table>
    </td></tr>
  </table>
</body>
</html>`;
}

function ownerHtml(order) {
  return `<!DOCTYPE html>
<html>
<head><meta charset="utf-8"/></head>
<body style="margin:0;padding:0;background:#f4f1ec">
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="padding:24px 12px">
    <tr><td align="center">
      <table role="presentation" width="600" cellpadding="0" cellspacing="0" style="max-width:600px;width:100%;background:#fff;border:1px solid #e3ded5;font-family:Arial,Helvetica,sans-serif">
        <tr>
          <td style="background:${CHARCOAL};padding:18px 26px;color:${GOLD};font-size:15px;letter-spacing:2px">
            NEW ORDER &middot; ${esc(order.orderNo)}
          </td>
        </tr>
        <tr>
          <td style="padding:22px 26px">
            <table role="presentation" width="100%" style="font-size:13px;color:#55504a">
              <tr><td style="padding:3px 0">Customer</td><td style="padding:3px 0;text-align:right;color:#222"><strong>${esc(order.memberName)}</strong></td></tr>
              <tr><td style="padding:3px 0">Email</td><td style="padding:3px 0;text-align:right;color:#222">${esc(order.memberEmail)}</td></tr>
              <tr><td style="padding:3px 0">Payment</td><td style="padding:3px 0;text-align:right;color:#222">${esc(order.cardLast4)}</td></tr>
              <tr><td style="padding:3px 0">Total</td><td style="padding:3px 0;text-align:right;color:#222"><strong>${money(order.total)} AUD</strong></td></tr>
            </table>

            <table role="presentation" width="100%" style="border-collapse:collapse;margin-top:18px">
              ${itemRows(order)}
            </table>

            <div style="font-size:12px;letter-spacing:2px;color:#8a8279;margin:22px 0 8px">SHIP TO</div>
            <p style="font-size:14px;color:#222;margin:0;line-height:1.6">
              ${order.memberName ? "<strong>" + esc(order.memberName) + "</strong><br/>" : ""}
              ${esc(order.shipping.address)}<br/>
              ${esc(order.shipping.city)} ${esc(order.shipping.state)} ${esc(order.shipping.zip)}
            </p>
            <p style="font-size:13px;color:#55504a;margin:10px 0 0;line-height:1.7">
              ${
                order.memberEmail
                  ? `<a href="mailto:${esc(order.memberEmail)}" style="color:#8a6d33">${esc(order.memberEmail)}</a><br/>`
                  : ""
              }
              ${
                order.memberPhone
                  ? `<a href="tel:${esc(order.memberPhone)}" style="color:#8a6d33">${esc(order.memberPhone)}</a>`
                  : `<span style="color:#a09890">No phone number collected</span>`
              }
            </p>

            <p style="font-size:12px;color:#8a8279;margin:22px 0 0">
              ${
                order.memberEmail
                  ? "An invoice has been emailed to the customer."
                  : "<strong style='color:#b3261e'>No customer email on file — no invoice was sent.</strong>"
              }
            </p>
          </td>
        </tr>
      </table>
    </td></tr>
  </table>
</body>
</html>`;
}

/* ------------------------------------------------------------------ *
 *  Sending
 * ------------------------------------------------------------------ */
async function sendEmail({ to, subject, html, replyTo }) {
  const payload = {
    from: `${BIZ.tradingName} <${BIZ.fromEmail}>`,
    to: [to],
    subject,
    html,
  };
  if (replyTo) payload.reply_to = replyTo;

  const res = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${process.env.RESEND_API_KEY}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(payload),
  });

  if (!res.ok) {
    const detail = await res.text();
    throw new Error(`Resend ${res.status}: ${detail.slice(0, 300)}`);
  }
}

async function sendOrderEmails(order) {
  if (!process.env.RESEND_API_KEY) return; // silently skip if not configured yet

  const jobs = [];

  // Customer invoice — only if we actually have an address for them.
  if (order.memberEmail) {
    jobs.push(
      sendEmail({
        to: order.memberEmail,
        subject: `Your order ${order.orderNo} — The Private Reserve`,
        html: invoiceHtml(order),
      }).catch((e) => console.error("customer invoice failed", e))
    );
  } else {
    console.error("no customer email on order", order.orderNo);
  }

  // Owner notification — reply goes straight to the customer.
  jobs.push(
    sendEmail({
      to: BIZ.ownerEmail,
      subject: `Order ${order.orderNo} — ${money(order.total)} — ${order.memberName}`,
      html: ownerHtml(order),
      replyTo: order.memberEmail || undefined,
    }).catch((e) => console.error("owner notification failed", e))
  );

  await Promise.all(jobs); // never throws — the order is already saved
}

/* ------------------------------------------------------------------ *
 *  Handler
 * ------------------------------------------------------------------ */
exports.handler = async (event) => {
  try {
    const sessionId = event.queryStringParameters && event.queryStringParameters.session_id;
    if (!sessionId) return { statusCode: 400, body: JSON.stringify({ error: "Missing session_id." }) };

    const stripe = Stripe(process.env.STRIPE_SECRET_KEY);
    const session = await stripe.checkout.sessions.retrieve(sessionId, {
      expand: ["payment_intent.payment_method", "line_items.data.price.product"],
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

    // The cart is read back from the line items, where each one carries its own
    // product id. The old approach packed the whole cart into session metadata,
    // which Stripe caps at 500 characters — big carts simply failed. The metadata
    // fallback stays for any session created before that change.
    const lineItems = (session.line_items && session.line_items.data) || [];
    const fromLines = lineItems
      .filter(l => l.price && l.price.product && l.price.product.metadata && l.price.product.metadata.pid)
      .map(l => ({
        id: l.price.product.metadata.pid,
        variant: l.price.product.metadata.variant || "single",
        qty: l.quantity,
      }));
    const cartItems = fromLines.length
      ? fromLines
      : JSON.parse(session.metadata.cart || "[]");
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
      // Only populated if phone collection is enabled in create-checkout.js.
      // Falls back to the shipping contact phone, then empty.
      memberPhone:
        session.customer_details?.phone ||
        (session.shipping_details && session.shipping_details.phone) ||
        "",
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

    await sendOrderEmails(order);

    return { statusCode: 200, body: JSON.stringify({ paid: true, order }) };
  } catch (err) {
    console.error(err);
    return { statusCode: 500, body: JSON.stringify({ error: err.message }) };
  }
};
