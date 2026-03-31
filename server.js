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
          console.error('Supabase fout bij mandate-opslag:', error);
          return res.status(500).json({ error: error.message });
        }

        console.log('Klant opgeslagen in Supabase:', data);
      }
    }

    if (
      event.type === 'payment_intent.processing' ||
      event.type === 'payment_intent.succeeded' ||
      event.type === 'payment_intent.payment_failed'
    ) {
      const paymentIntent = event.data.object;
      const email = paymentIntent.metadata?.email || null;

      if (!email) {
        console.warn('Geen email in metadata van payment intent:', paymentIntent.id);
        return res.sendStatus(200);
      }

      let errorMessage = null;

      if (event.type === 'payment_intent.payment_failed') {
        errorMessage =
          paymentIntent.last_payment_error?.message ||
          'Betaling mislukt zonder specifieke foutmelding.';
      }

      const { error: updateError } = await supabase
        .from('customers')
        .update({
          last_payment_intent_id: paymentIntent.id,
          last_payment_status: paymentIntent.status,
          last_payment_error: errorMessage
        })
        .eq('email', email);

      if (updateError) {
        console.error('Supabase fout bij payment webhook:', updateError);
        return res.status(500).json({ error: updateError.message });
      }

      console.log(`Payment webhook verwerkt voor ${email}: ${paymentIntent.status}`);
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
app.post('/collect-payment', async (req, res) => {
  const { email, amount, description, invoice_number, exact_debtor_id } = req.body;

  if (!email || !amount) {
    return res.status(400).json({ error: 'Email en amount zijn verplicht.' });
  }

  try {
    const { data: customerRecord, error: dbError } = await supabase
      .from('customers')
      .select('*')
      .eq('email', email)
      .single();

    if (dbError || !customerRecord) {
      return res.status(404).json({ error: 'Klant niet gevonden in database.' });
    }

    if (!customerRecord.sepa_active || !customerRecord.stripe_payment_method) {
      return res.status(400).json({ error: 'Geen actieve SEPA machtiging gevonden voor deze klant.' });
    }

    const paymentIntent = await stripe.paymentIntents.create({
      amount: amount,
      currency: 'eur',
      customer: customerRecord.stripe_customer_id,
      payment_method: customerRecord.stripe_payment_method,
      payment_method_types: ['sepa_debit'],
      confirm: true,
      description: description || 'SEPA incasso via Spectaculis',
      metadata: {
        email,
        invoice_number: invoice_number || '',
        exact_debtor_id: exact_debtor_id || '',
      }
    });

    const { error: updateError } = await supabase
      .from('customers')
      .update({
        last_payment_intent_id: paymentIntent.id,
        last_payment_status: paymentIntent.status,
        last_payment_error: null,
        exact_debtor_id: exact_debtor_id || customerRecord.exact_debtor_id || null
      })
      .eq('email', email);

    if (updateError) {
      console.error('Supabase update fout na collect-payment:', updateError);
    }

    res.json({
      success: true,
      payment_intent_id: paymentIntent.id,
      status: paymentIntent.status
    });
  } catch (err) {
    console.error('Fout bij collect-payment:', err);
    res.status(500).json({ error: err.message });
  }
});
app.get('/test-collect', async (req, res) => {
  try {
    const email = 'nijkamp@generalmail.com';
    const amount = 100; // 1 euro in centen

    const { data: customerRecord, error: dbError } = await supabase
      .from('customers')
      .select('*')
      .eq('email', email)
      .single();

    if (dbError || !customerRecord) {
      return res.status(404).json({ error: 'Klant niet gevonden in database.' });
    }

    const paymentIntent = await stripe.paymentIntents.create({
      amount: amount,
      currency: 'eur',
      customer: customerRecord.stripe_customer_id,
      payment_method: customerRecord.stripe_payment_method,
      payment_method_types: ['sepa_debit'],
      confirm: true,
      description: 'Test SEPA incasso Spectaculis',
      metadata: {
        email,
        invoice_number: '',
        exact_debtor_id: ''
      }
    });

    const { error: updateError } = await supabase
      .from('customers')
      .update({
        last_payment_intent_id: paymentIntent.id,
        last_payment_status: paymentIntent.status,
        last_payment_error: null
      })
      .eq('email', email);

    if (updateError) {
      console.error('Supabase update fout na test-collect:', updateError);
    }

    res.json({
      success: true,
      payment_intent_id: paymentIntent.id,
      status: paymentIntent.status
    });
  } catch (err) {
    console.error('Fout bij test-collect:', err);
    res.status(500).json({ error: err.message });
  }
});
app.get('/customers/:email', async (req, res) => {
  const email = decodeURIComponent(req.params.email);

  try {
    const { data, error } = await supabase
      .from('customers')
      .select('*')
      .eq('email', email)
      .single();

    if (error) {
      return res.status(404).json({ error: 'Klant niet gevonden.' });
    }

    res.json(data);
  } catch (err) {
    console.error('Fout bij ophalen klant:', err);
    res.status(500).json({ error: err.message });
  }
});
app.listen(PORT, () => {
  console.log(`Server draait op poort ${PORT}`);
});
