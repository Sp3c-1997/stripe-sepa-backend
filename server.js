const express = require('express');
const stripe = require('stripe')(process.env.STRIPE_SECRET_KEY);

const app = express();
app.use(express.json());

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
      success_url: 'https://jouwdomein.nl/pages/incasso-gelukt',
      cancel_url: 'https://jouwdomein.nl/pages/incasso-geannuleerd',
    });

    res.json({ url: session.url });

  } catch (err) {
    res.status(500).send(err.message);
  }
});

app.post('/webhook', (req, res) => {
  console.log('Webhook ontvangen');
  res.sendStatus(200);
});

app.listen(3000, () => console.log('Server draait'));
