require('dotenv').config();
const express = require('express');
const axios = require('axios');
const { v4: uuidv4 } = require('uuid');
const mongoose = require('mongoose');
const path = require('path');
const app = express();
const PORT = process.env.PORT || 3000;

app.use(express.static(path.join(__dirname, 'public')));
app.use(express.urlencoded({ extended: true }));
app.use(express.json());

// MongoDB connection
mongoose.connect(process.env.MONGODB_URI, {
  useNewUrlParser: true,
  useUnifiedTopology: true
}).then(() => console.log('MongoDB connected')).catch(err => console.log('MongoDB error:', err));

// ========== SCHEMAS ==========
const UserSchema = new mongoose.Schema({
  userId: { type: String, unique: true },
  name: String,
  email: String,
  phone: String,
  password: String,
  balance: { type: Number, default: 250000 },
  paid: { type: Boolean, default: false },
  transactionRef: String,
  createdAt: { type: Date, default: Date.now }
});

const TransactionSchema = new mongoose.Schema({
  userId: String,
  email: String,
  reference: String,
  amount: { type: Number, default: 7500 },
  status: { type: String, default: 'pending' },
  paystackResponse: Object,
  createdAt: { type: Date, default: Date.now }
});

const User = mongoose.model('User', UserSchema);
const Transaction = mongoose.model('Transaction', TransactionSchema);

// ========== ROUTES ==========
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

app.post('/signup', async (req, res) => {
  const userId = uuidv4();
  const newUser = new User({
    userId,
    name: req.body.name,
    email: req.body.email,
    phone: req.body.phone,
    password: req.body.password,
    balance: 250000,
    paid: false
  });
  await newUser.save();
  res.redirect(`/dashboard?userId=${userId}`);
});

app.get('/dashboard', (req, res) => {
  const userId = req.query.userId;
  if (!userId) return res.redirect('/');
  res.sendFile(path.join(__dirname, 'public', 'dashboard.html'));
});

app.get('/api/balance', async (req, res) => {
  const userId = req.query.userId;
  if (!userId) return res.status(401).json({ error: 'Invalid user' });
  const user = await User.findOne({ userId });
  if (!user) return res.status(404).json({ error: 'User not found' });
  res.json({ balance: user.balance, paid: user.paid });
});

app.post('/api/initiate-payment', async (req, res) => {
  const { userId } = req.body;
  if (!userId) return res.status(400).json({ error: 'Invalid user' });
  
  const user = await User.findOne({ userId });
  if (!user) return res.status(404).json({ error: 'User not found' });

  const amount = 7500;
  const email = user.email;
  const reference = `BPC-${uuidv4().slice(0, 8)}`;

  user.transactionRef = reference;
  await user.save();

  try {
    const response = await axios.post('https://api.paystack.co/transaction/initialize', {
      email,
      amount: amount * 100,
      reference,
      callback_url: `${process.env.SITE_URL}/verify-payment?userId=${userId}`
    }, {
      headers: {
        Authorization: `Bearer ${process.env.PAYSTACK_SECRET_KEY}`,
        'Content-Type': 'application/json'
      }
    });

    const tx = new Transaction({
      userId,
      email,
      reference,
      amount,
      status: 'pending'
    });
    await tx.save();

    res.json({ 
      authorization_url: response.data.data.authorization_url,
      reference: reference
    });
  } catch (err) {
    console.error(err.response?.data || err.message);
    res.status(500).json({ error: 'Payment initialization failed' });
  }
});

app.get('/verify-payment', async (req, res) => {
  const { userId, reference } = req.query;
  if (!userId || !reference) return res.redirect('/');

  const user = await User.findOne({ userId });
  if (!user) return res.redirect('/');

  try {
    const response = await axios.get(`https://api.paystack.co/transaction/verify/${reference}`, {
      headers: { Authorization: `Bearer ${process.env.PAYSTACK_SECRET_KEY}` }
    });

    const data = response.data.data;
    const tx = await Transaction.findOne({ reference });

    if (data.status === 'success') {
      user.paid = true;
      await user.save();
      if (tx) {
        tx.status = 'success';
        tx.paystackResponse = data;
        await tx.save();
      }
      res.redirect(`/processing?userId=${userId}`);
    } else {
      if (tx) {
        tx.status = 'failed';
        tx.paystackResponse = data;
        await tx.save();
      }
      res.redirect(`/fail?userId=${userId}`);
    }
  } catch (err) {
    console.error(err.message);
    res.redirect(`/fail?userId=${userId}`);
  }
});

app.get('/processing', (req, res) => {
  const userId = req.query.userId;
  if (!userId) return res.redirect('/');
  res.sendFile(path.join(__dirname, 'public', 'processing.html'));
});

app.get('/fail', async (req, res) => {
  const userId = req.query.userId;
  if (userId) {
    await User.findOneAndUpdate({ userId }, { paid: false });
  }
  res.sendFile(path.join(__dirname, 'public', 'fail.html'));
});

// Admin route - view all users and transactions
app.get('/admin', async (req, res) => {
  const users = await User.find();
  const txs = await Transaction.find().sort({ createdAt: -1 }).limit(50);
  res.json({ users, transactions: txs });
});

app.listen(PORT, () => {
  console.log(`GoldVault running on http://localhost:${PORT}`);
});
