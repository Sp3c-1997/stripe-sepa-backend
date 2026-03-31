const express = require('express');
const cors = require('cors');
const Stripe = require('stripe');
const { createClient } = require('@supabase/supabase-js');

const stripe = new Stripe(process.env.STRIPE_SECRET_KEY);
const app = express();
const PORT = process.env.PORT || 3000;

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_KEY
);

app.use(cors({
  origin: ['https://www.spectaculis.nl', 'https://spectaculis.nl'],
  methods: ['GET', 'POST'],
  allowedHeaders: ['Content-Type', 'Stripe-Signature']
}));

app.use(express.json());

app.get('/', (req, res) => {
  res.send('Backend draait');
});

app.get('/debug-env', (req, res) => {
  res.json({
    hasStripeKey: !!process.env.STRIPE_SECRET_KEY,
    stripePrefix: process.env.STRIPE_SECRET_KEY ? process.env.STRIPE_SECRET_KEY.slice(0, 8) : null,
    hasSupabaseUrl: !!process.env.SUPABASE_URL,
    hasSupabaseKey: !!process.env.SUPABASE_KEY
  });
});

app.post('/create-session', async (req, res) => {
  const { email } = req.body;

  if (!email) {
    return res.status(400).json({ error: 'Email is verplicht.' });
  }

  try {
    const customer = await stripe.customers.create({
      email
    });

    const session = await stripe.checkout.sessions.create({
      mode: 'setup',
      customer: customer.id,
      payment_method_types: ['sepa_debit'],
      success_url: 'https://www.spectaculis.nl/pages/incasso-gelukt',
      cancel_url: 'https://www.spectaculis.nl/pages/incasso-geannuleerd'
    });

    res.json({ url: session.url });
  } catch (err) {
    console.error('Stripe fout bij create-session:', err);
    res.status(500).json({ error: err.message });
  }
});

app.post('/webhook', async (req, res) => {
  const event = req.body;

  try {
    if (event.type === 'checkout.session.completed') {
      const session = event.data.object;

      if (session.mode === 'setup') {
        const stripeCustomerId = session.customer;
        const setupIntentId = session.setup_intent;

        const setupIntent = await stripe.setupIntents.retrieve(setupIntentId);
        const paymentMethodId = setupIntent.payment_method;

        const customer = await stripe.customers.retrieve(stripeCustomerId);
        const email = customer.email || null;

        const payload = {
          email,
          stripe_customer_id: stripeCustomerId,
          stripe_payment_method: paymentMethodId,
          sepa_active: true,
          exact_debtor_id: null
        };

        const { data, error } = await supabase
          .from('customers')
          .upsert(payload, { onConflict: 'email' })
          .select();

        if (error) {
          console.error('Supabase fout:', error);
          return res.status(500).json({ error: error.message });
        }

        console.log('Klant opgeslagen in Supabase:', data);
      }
    }

    res.sendStatus(200);
  } catch (err) {
    console.error('Webhook fout:', err);
    res.status(500).json({ error: err.message });
  }
});

app.get('/customers', async (req, res) => {
  try {
    const { data, error } = await supabase
      .from('customers')
      .select('*')
      .order('id', { ascending: false });

    if (error) {
      return res.status(500).json({ error: error.message });
    }

    res.json(data);
  } catch (err) {
    console.error('Fout bij ophalen customers:', err);
    res.status(500).json({ error: err.message });
  }
});

app.listen(PORT, () => {
  console.log(`Server draait op poort ${PORT}`);
});
