const express = require('express');
const cors = require('cors');
const stripe = require('stripe')(process.env.STRIPE_SECRET_KEY);

const app = express();
const PORT = process.env.PORT || 3000;

app.use(cors({
  origin: ['https://www.spectaculis.nl', 'https://spectaculis.nl'],
  methods: ['GET', 'POST'],
  allowedHeaders: ['Content-Type']
}));

app.use(express.json());

app.get('/', (req, res) => {
  res.send('Backend draait');
});

app.post('/create-session', async (req, res) => {
  const { email } = req.body;

  try {
    const customer = await stripe.customers.create({
      email: email,
    });

    const session = await stripe.checkout.sessions.create({
      mode: 'setup',
      customer: customer.id,
      payment_method_types: ['sepa_debit'],
      success_url: 'https://www.spectaculis.nl/pages/incasso-gelukt',
      cancel_url: 'https://www.spectaculis.nl/pages/incasso-geannuleerd',
    });

    res.json({ url: session.url });
  } catch (err) {
    console.error('Stripe fout:', err);
    res.status(500).json({ error: err.message });
  }
});

app.post('/webhook', (req, res) => {
  console.log('Webhook ontvangen');
  res.sendStatus(200);
});

app.listen(PORT, () => console.log(`Server draait op poort ${PORT}`));
