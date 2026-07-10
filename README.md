# The Private Reserve — Installable Web App

This is a complete, working app: invite-gated membership, storefront, cart, checkout,
and a full back office (products, orders, members, invite codes). It's built to be
opened in a phone's browser and added to the home screen — no App Store or Play
Store needed.

## Get a live link (free, ~2 minutes, no coding)

1. Go to **https://app.netlify.com/drop**
2. Drag this whole folder (`private-reserve-pwa`) onto the page.
3. Netlify gives you a live `https://yourname.netlify.app` link immediately.
4. Send that link to your customers.

That's it — it's live. You can rename the site (Site settings → Change site name) to
get a nicer link, or connect your own domain later (Site settings → Domain management)
if you own one.

Other one-click options that work the same way: Vercel (vercel.com), Cloudflare Pages,
or GitHub Pages if you're already using GitHub.

## How customers install it

- **iPhone**: open the link in Safari → tap the Share icon → "Add to Home Screen."
- **Android**: open the link in Chrome → tap the ⋮ menu → "Install app" (or a banner
  will offer this automatically — it's built into the app).

Once installed it opens full-screen with its own icon, like a normal app.

## How access works

- You generate invite codes from the **Back Office** (Invite Codes tab).
- A customer redeems a code once to set their name, email, and password — after that
  they just sign in.
- You get into the Back Office through the "Proprietor" tab on the entry screen,
  using the passcode (default `humidor21` — change it immediately under
  Back Office → Settings).

## Important limitations to know about

**Data is now shared across every device**, backed by a live Supabase database.
Products, orders, members, and invite codes you add on one phone/computer show up
everywhere else — tap the ⟳ refresh icon in the top bar to pull the latest if it
doesn't update automatically (it also refreshes on login and on load).

A note on how that's secured: the app's invite-code and proprietor-passcode gate is
what protects your data, not a database-level wall — the database itself is open to
anyone holding the app's key. That's normal for a small private app like this, but
worth knowing. If this ever needs to handle serious volume or sensitive data at scale,
a proper user-authentication layer (Supabase Auth) is the next step up — ask any time.

**Payments are now real, powered by Stripe.** See the "Setting up real payments" section
below to finish connecting your Stripe account — until that's done, checkout will show
an error since there's no live Stripe key configured yet.

## Setting up real payments (Stripe)

This part requires switching from the simple drag-and-drop Netlify deploy to a
GitHub-connected deploy, because accepting real payments needs a small piece of
server-side code (already written for you, in `netlify/functions/`) that Netlify needs
to build. Your app's look, features, and data all stay exactly the same — this only
changes *how* the site gets published.

**1. Create a Stripe account**
Go to stripe.com → sign up. Start in **test mode** (there's a toggle in the dashboard)
so you can try the whole flow with fake cards before taking real payments.

**2. Get your Stripe secret key**
Dashboard → Developers → API keys → copy the **Secret key** (starts with `sk_test_...`
in test mode, `sk_live_...` once you switch to live). Keep this private — never put it
in the app's own code, only in Netlify's settings (next steps).

**3. Put this project on GitHub**
- Create a free account at github.com if you don't have one.
- Click **New repository**, give it a name (e.g. `private-reserve`), keep it Private,
  click **Create repository**.
- On the next page, use **"uploading an existing file"** — drag this entire project
  folder's contents in, and commit.

**4. Connect Netlify to that GitHub repo**
- Netlify dashboard → **Add new site → Import an existing project**.
- Choose GitHub, authorize it, pick your new repository.
- Leave the build settings as detected (this project's `netlify.toml` already tells
  Netlify what to do) and click **Deploy**.

**5. Add your secret key to Netlify**
- On your new site in Netlify → **Site configuration → Environment variables**.
- Add a variable named exactly `STRIPE_SECRET_KEY`, value = the secret key from step 2.
- Redeploy the site (Deploys tab → Trigger deploy) so it picks up the new variable.

**6. Test it**
Add something to your cart, check out, and use Stripe's official test card:
`4242 4242 4242 4242`, any future expiry date, any 3-digit CVC, any ZIP. It should
complete and the order should appear in your Back Office → Orders tab.

**7. Go live**
Once you're happy, switch Stripe's dashboard to live mode, copy the **live** secret key
(`sk_live_...`), and replace the `STRIPE_SECRET_KEY` value in Netlify with it. Real cards
will now be charged.

## Files in this folder

- `index.html` — the entire app (structure, styling, logic)
- `manifest.json` — tells the phone how to install the app (name, icon, colors)
- `service-worker.js` — lets the app open reliably and work offline once installed
- `icon-192.png`, `icon-512.png`, `apple-touch-icon.png` — home screen icons
- `functions/` — the two small pieces of server-side code that talk to Stripe securely
  (`create-checkout.js` and `verify-order.js`)
- `netlify.toml` — tells Netlify where to find the app and the functions folder

When uploading to GitHub: drag the `functions` folder in as a whole folder (so it stays
nested), and drag everything else in as loose files alongside it.
