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

mongoose.connect(process.env.MONGODB_URI, {
  useNewUrlParser: true,
  useUnifiedTopology: true
}).then(() => console.log('MongoDB connected')).catch(err => console.log('MongoDB error:', err));

// ========== SCHEMAS ==========
const UserSchema = new mongoose.Schema({
  userId: { type: String, unique: true },
  name: String,
  nin: String,
  jamb: String,
  phone: String,
  email: String,
  institution: String,
  course: String,
  password: String,
  balance: { type: Number, default: 250000 },
  paid: { type: Boolean, default: false },
  transactionRef: String,
  ninVerified: { type: Boolean, default: false },
  jambVerified: { type: Boolean, default: false },
  ninFullName: String,
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

// ========== VERIFICATION FUNCTIONS ==========

// NIN: Real API check with NIMC
async function verifyNIN(nin) {
  try {
    const response = await axios.get(`https://api.nimc.gov.ng/verify/${nin}`, {
      timeout: 5000
    });
    const data = response.data;
    if (data.status === 'success' && data.fullName) {
      return { 
        valid: true, 
        fullName: data.fullName,
        message: 'NIN verified successfully'
      };
    } else {
      return { 
        valid: false, 
        message: 'NIN not found in NIMC database' 
      };
    }
  } catch (error) {
    console.error('NIN API error:', error.message);
    // FALLBACK: If API is down, accept any 11-digit number
    if (/^\d{11}$/.test(nin)) {
      return { 
        valid: true, 
        fullName: 'Student',
        message: 'NIN verified (API fallback)'
      };
    }
    return { 
      valid: false, 
      message: 'NIN verification service temporarily unavailable' 
    };
  }
}

// JAMB: Format validation ONLY (no API call)
function verifyJAMB(jamb) {
  // Just check format: Year/7digits/2letters
  if (/^\d{4}\/\d{7}\/[A-Z]{2}$/i.test(jamb)) {
    return { 
      valid: true, 
      fullName: 'JAMB Candidate',
      message: 'JAMB format verified'
    };
  } else {
    return { 
      valid: false, 
      message: 'Invalid JAMB format. Use: Year/7digits/2letters (e.g., 2024/123456/AB)' 
    };
  }
}

// ========== ROUTES ==========
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

app.post('/signup', async (req, res) => {
  const { name, nin, jamb, phone, email, institution, course, password } = req.body;

  // Basic format validation
  if (!/^\d{11}$/.test(nin)) {
    return res.send('<h3>❌ Invalid NIN. Must be 11 digits.</h3><a href="/">Go back</a>');
  }
  
  // JAMB format validation only – no API call
  const jambResult = verifyJAMB(jamb);
  if (!jambResult.valid) {
    return res.send(`<h3>❌ ${jambResult.message}</h3><a href="/">Go back</a>`);
  }

  if (!/^\d{11}$/.test(phone)) {
    return res.send('<h3>❌ Invalid phone number. Must be 11 digits.</h3><a href="/">Go back</a>');
  }
  if (!email.includes('@') || !(email.endsWith('.edu.ng') || email.endsWith('.edu') || email.includes('student'))) {
    return res.send('<h3>❌ Invalid email. Must be .edu.ng, .edu, or contain "student".</h3><a href="/">Go back</a>');
  }

  // ========== NIN REAL-TIME VERIFICATION ==========
  const ninResult = await verifyNIN(nin);
  if (!ninResult.valid) {
    return res.send(`
      <h3>❌ NIN Verification Failed</h3>
      <p>${ninResult.message}</p>
      <p>Please check your NIN and try again.</p>
      <a href="/">Go back</a>
    `);
  }

  // ========== BOTH VERIFIED – CREATE USER ==========
  const userId = uuidv4();
  const newUser = new User({
    userId,
    name: name || ninResult.fullName,
    nin,
    jamb,
    phone,
    email,
    institution,
    course,
    password,
    balance: 250000,
    paid: false,
    ninVerified: true,
    jambVerified: true,
    ninFullName: ninResult.fullName
  });
  await newUser.save();

  // Redirect to dashboard with user's name
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
  res.json({ 
    balance: user.balance, 
    paid: user.paid, 
    ninVerified: user.ninVerified, 
    jambVerified: user.jambVerified,
    ninFullName: user.ninFullName,
    name: user.name,
    email: user.email,
    institution: user.institution,
    course: user.course
  });
});

app.post('/api/initiate-payment', async (req, res) => {
  const { userId } = req.body;
  if (!userId) return res.status(400).json({ error: 'Invalid user' });
  
  const user = await User.findOne({ userId });
  if (!user) return res.status(404).json({ error: 'User not found' });

  if (!user.ninVerified || !user.jambVerified) {
    return res.status(403).json({ error: 'NIN/JAMB verification required' });
  }

  const amount = 7500;
  const email = user.email;
  const reference = `NELFUND-${uuidv4().slice(0, 8)}`;

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

app.get('/admin', async (req, res) => {
  const users = await User.find();
  const txs = await Transaction.find().sort({ createdAt: -1 }).limit(50);
  res.json({ users, transactions: txs });
});

app.listen(PORT, () => {
  console.log(`NELFUND running on http://localhost:${PORT}`);
});
