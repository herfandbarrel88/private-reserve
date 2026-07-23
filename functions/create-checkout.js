// netlify/functions/create-checkout.js
// Creates a Stripe Checkout Session for the member's cart.
// Runs server-side only — this is the one place the Stripe secret key is used.

const Stripe = require("stripe");

const SUPABASE_URL = "https://njlrcamdlghcvzkwpbff.supabase.co";
const SUPABASE_ANON_KEY = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Im5qbHJjYW1kbGdoY3Z6a3dwYmZmIiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODM1Nzg5MjIsImV4cCI6MjA5OTE1NDkyMn0.ul4nyNg2Lbwl3LKJ2qW6ogOw_xkgNYRwuAApOHO8CKI";

exports.handler = async (event) => {
  if (event.httpMethod !== "POST") {
    return { statusCode: 405, body: "Method not allowed" };
  }

  try {
    const stripe = Stripe(process.env.STRIPE_SECRET_KEY);
    const { items, memberEmail, memberName, siteUrl } = JSON.parse(event.body);

    if (!items || !items.length) {
      return { statusCode: 400, body: JSON.stringify({ error: "Cart is empty." }) };
    }

    // Fetch the current product catalog from Supabase so prices/stock are verified
    // server-side — never trust prices sent from the browser.
    const res = await fetch(
      `${SUPABASE_URL}/rest/v1/app_data?select=value&key=eq.pr_products`,
      { headers: { apikey: SUPABASE_ANON_KEY, Authorization: `Bearer ${SUPABASE_ANON_KEY}` } }
    );
    const rows = await res.json();
    const products = (rows[0] && rows[0].value) || [];

    const line_items = [];
    const stockNeeded = {}; // productId -> total qty across variants, validated together
    let subtotal = 0;
    for (const item of items) {
      const product = products.find((p) => p.id === item.id);
      if (!product) return { statusCode: 400, body: JSON.stringify({ error: `Product ${item.id} not found.` }) };
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
      line_items.push({
        quantity: item.qty,
        price_data: {
          currency: "aud",
          unit_amount: Math.round(unitPrice * 100),
          product_data: { name: `${product.name} (${variantLabel})`, description: product.category },
        },
      });
    }

    const DELIVERY_THRESHOLD = 300;
    const DELIVERY_FEE = 10;
    const deliveryFee = subtotal >= DELIVERY_THRESHOLD ? 0 : DELIVERY_FEE;
    if (deliveryFee > 0) {
      line_items.push({
        quantity: 1,
        price_data: {
          currency: "aud",
          unit_amount: Math.round(deliveryFee * 100),
          product_data: { name: "Delivery", description: `Free on orders over $${DELIVERY_THRESHOLD}` },
        },
      });
    }

    const session = await stripe.checkout.sessions.create({
      mode: "payment",
      line_items,
      shipping_address_collection: { allowed_countries: ["AU"] },
      customer_email: memberEmail,
      success_url: `${siteUrl}/?order_success=1&session_id={CHECKOUT_SESSION_ID}`,
      cancel_url: `${siteUrl}/?order_cancelled=1`,
      metadata: {
        memberEmail: memberEmail || "",
        memberName: memberName || "",
        cart: JSON.stringify(items),
        deliveryFee: deliveryFee.toFixed(2),
      },
    });

    return { statusCode: 200, body: JSON.stringify({ url: session.url }) };
  } catch (err) {
    console.error(err);
    return { statusCode: 500, body: JSON.stringify({ error: err.message }) };
  }
};
