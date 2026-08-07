// Creates a Stripe Checkout Session so every charge is labeled with the
// product name in the Stripe dashboard (instead of "Charge for email@...").
//
// Required Vercel env vars:
//   STRIPE_SECRET_KEY    - your Stripe secret key (sk_live_...)
//   STRIPE_PRICE_VOUCHER - the Price ID (price_...) of the voucher product
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
  },
  // Add future drops here, e.g.:
  // minis2027: {
  //   name: 'MWP 2027 Mini Sessions',
  //   priceEnv: 'STRIPE_PRICE_MINIS2027',
  //   couponEnv: 'STRIPE_COUPON_MINIS2027',
  // },
};

const SITE = 'https://www.marcowang.com';

export default async function handler(req, res) {
  const STRIPE_KEY = process.env.STRIPE_SECRET_KEY;
  if (!STRIPE_KEY) {
    return res.status(500).send('Server misconfigured');
  }

  const slug = (req.query && req.query.product) || 'voucher';
  const product = PRODUCTS[slug];
  if (!product) {
    return res.status(404).send('Unknown product');
  }

  const priceId = process.env[product.priceEnv];
  if (!priceId) {
    return res.status(500).send('Missing price configuration');
  }

  const params = new URLSearchParams();
  params.append('mode', 'payment');
  params.append('line_items[0][price]', priceId);
  params.append('line_items[0][quantity]', '1');
  // This is what makes the charge readable in the Stripe payments list:
  params.append('payment_intent_data[description]', product.name);
  params.append('payment_intent_data[metadata][product]', slug);
  params.append('metadata[product]', slug);
  params.append('success_url', `${SITE}/drops?status=success`);
  params.append('cancel_url', `${SITE}/drops`);
  params.append('automatic_tax[enabled]', 'true');

  // Sale: auto-apply the coupon if one is configured. Stripe does not allow
  // discounts[] and allow_promotion_codes together, so this is either/or.
  const couponId = product.couponEnv ? process.env[product.couponEnv] : null;
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
      console.error('Stripe error:', session.error ? session.error.message : response.status);
      return res.status(502).send('Unable to start checkout. Please try again or email info@marcowang.com.');
    }

    res.setHeader('Cache-Control', 'no-store');
    return res.redirect(303, session.url);
  } catch (err) {
    console.error('Checkout error:', err);
    return res.status(500).send('Unable to start checkout. Please try again or email info@marcowang.com.');
  }
}
