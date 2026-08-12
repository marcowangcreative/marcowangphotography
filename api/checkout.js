// Creates a Stripe Checkout Session so every charge is labeled with the
// product name in the Stripe dashboard (instead of "Charge for email@...").
//
// Required Vercel env vars:
//   STRIPE_SECRET_KEY    - your Stripe secret key (sk_live_...)
//   STRIPE_PRICE_VOUCHER - the Price ID (price_...) of the voucher product
//
// Optional — add-ons:
//   STRIPE_PRICE_ADDON_STYLING - Price ID for "On-Site Styling with Jordan".
//     Reached via /api/checkout?product=voucher&addon=styling. Added as its own
//     line item, so it shows separately on the receipt. NOTE: give it its own
//     Stripe tax category — a beauty service is not taxed the same way as
//     photography in Texas, and leaving it uncategorized repeats the $0-tax bug.
//
// Optional — running a sale:
//   STRIPE_COUPON_VOUCHER - a Coupon ID from Stripe. When set, it is applied
//     automatically at checkout (no code for the buyer to type). To END the
//     sale, delete this env var and redeploy — nothing else changes.
//
// Stripe Tax is always on. Each product must carry its own tax code
// (the voucher uses txcd_10501000, Digital Photographs/Images) — without
// one it falls back to "General - Services" and Texas sales calculate to $0.
// Tax is calculated on the DISCOUNTED subtotal, which is the correct behavior.
//
// Usage from the site: link to /api/checkout?product=voucher

const PRODUCTS = {
  voucher: {
    name: 'MWP Portrait Session Voucher',
    priceEnv: 'STRIPE_PRICE_VOUCHER',
    couponEnv: 'STRIPE_COUPON_VOUCHER',
    addons: ['styling'],
  },
  // Add future drops here, e.g.:
  // minis2027: {
  //   name: 'MWP 2027 Mini Sessions',
  //   priceEnv: 'STRIPE_PRICE_MINIS2027',
  //   couponEnv: 'STRIPE_COUPON_MINIS2027',
  // },
};

// Optional extras added as their own Stripe line item, so they stay separately
// stated on the receipt — which also keeps a beauty service distinct from the
// photography for sales-tax purposes.
const ADDONS = {
  styling: {
    name: 'On-Site Styling with Jordan',
    priceEnv: 'STRIPE_PRICE_ADDON_STYLING',
  },
};

const SITE = 'https://www.marcowang.com';

// Env vars pasted into Vercel sometimes carry stray whitespace (a trailing
// space once broke the styling add-on with "No such price"). Trim everything.
const env = (name) => (process.env[name] || '').trim() || null;

export default async function handler(req, res) {
  const STRIPE_KEY = env('STRIPE_SECRET_KEY');
  if (!STRIPE_KEY) {
    return res.status(500).send('Server misconfigured');
  }

  const slug = (req.query && req.query.product) || 'voucher';
  const product = PRODUCTS[slug];
  if (!product) {
    return res.status(404).send('Unknown product');
  }

  const priceId = env(product.priceEnv);
  if (!priceId) {
    return res.status(500).send('Missing price configuration');
  }

  // Optional add-on, e.g. /api/checkout?product=voucher&addon=styling
  const addonSlug = req.query && req.query.addon;
  let addon = null;
  if (addonSlug) {
    const allowed = product.addons || [];
    if (!allowed.includes(addonSlug) || !ADDONS[addonSlug]) {
      return res.status(404).send('Unknown add-on');
    }
    const addonPriceId = env(ADDONS[addonSlug].priceEnv);
    if (!addonPriceId) {
      return res.status(500).send('Missing add-on price configuration');
    }
    addon = { slug: addonSlug, priceId: addonPriceId, name: ADDONS[addonSlug].name };
  }

  const description = addon ? `${product.name} + ${addon.name}` : product.name;

  const params = new URLSearchParams();
  params.append('mode', 'payment');
  params.append('line_items[0][price]', priceId);
  params.append('line_items[0][quantity]', '1');
  if (addon) {
    params.append('line_items[1][price]', addon.priceId);
    params.append('line_items[1][quantity]', '1');
  }
  // This is what makes the charge readable in the Stripe payments list:
  params.append('payment_intent_data[description]', description);
  params.append('payment_intent_data[metadata][product]', slug);
  params.append('metadata[product]', slug);
  if (addon) {
    params.append('payment_intent_data[metadata][addon]', addon.slug);
    params.append('metadata[addon]', addon.slug);
  }
  params.append('success_url', `${SITE}/drops?status=success${addon ? `&addon=${addon.slug}` : ''}`);
  params.append('cancel_url', `${SITE}/drops`);
  params.append('automatic_tax[enabled]', 'true');

  // Sale: auto-apply the coupon if one is configured. Stripe does not allow
  // discounts[] and allow_promotion_codes together, so this is either/or.
  const couponId = product.couponEnv ? env(product.couponEnv) : null;
  if (couponId) {
    params.append('discounts[0][coupon]', couponId);
  }

  try {
    const response = await fetch('https://api.stripe.com/v1/checkout/sessions', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${STRIPE_KEY}`,
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      body: params.toString(),
    });

    const session = await response.json();

    if (!response.ok || !session.url) {
      const detail = session.error ? session.error.message : `HTTP ${response.status}`;
      console.error('Stripe error:', detail);
      // Add ?debug=1 to the URL to see the actual Stripe error instead of the
      // friendly message. Buyers never see this; it just saves a trip to the logs.
      if (req.query && req.query.debug) {
        return res.status(502).send(`Stripe error: ${detail}`);
      }
      return res.status(502).send('Unable to start checkout. Please try again or email info@marcowang.com.');
    }

    res.setHeader('Cache-Control', 'no-store');
    return res.redirect(303, session.url);
  } catch (err) {
    console.error('Checkout error:', err);
    return res.status(500).send('Unable to start checkout. Please try again or email info@marcowang.com.');
  }
}
