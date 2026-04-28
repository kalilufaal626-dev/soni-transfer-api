const express = require('express');
const { Pool } = require('pg');
const dotenv = require('dotenv');

dotenv.config();

const app = express();
app.use(express.json());

// ─── Database Connection ───────────────────────────────────────────────────
const pool = new Pool({
  host:     process.env.DB_HOST,
  port:     process.env.DB_PORT || 5432,
  user:     process.env.DB_USER,
  password: process.env.DB_PASSWORD,
  database: process.env.DB_NAME,
  ssl: { rejectUnauthorized: false }
});

// ─── Health Check (public) ────────────────────────────────────────────────
app.get('/health', (req, res) => {
  res.json({ status: 'ok', timestamp: new Date().toISOString() });
});

// ─── API Key Middleware ────────────────────────────────────────────────────
app.use((req, res, next) => {
  const key = req.headers['x-api-key'];
  if (key !== process.env.API_KEY) {
    return res.status(401).json({ error: 'Unauthorized' });
  }
  next();
});

// ══════════════════════════════════════════════════════════════════
//  CUSTOMERS / KYC
// ══════════════════════════════════════════════════════════════════

app.get('/customers', async (req, res) => {
  try {
    const { rows } = await pool.query(
      'SELECT * FROM customers ORDER BY created_at DESC'
    );
    res.json(rows);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/customers/:id', async (req, res) => {
  try {
    const { rows } = await pool.query(
      'SELECT * FROM customers WHERE id = $1',
      [req.params.id]
    );
    if (!rows.length) return res.status(404).json({ error: 'Customer not found' });
    res.json(rows[0]);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/customers', async (req, res) => {
  const { full_name, email, phone, id_number, id_type, kyc_status } = req.body;
  try {
    const { rows } = await pool.query(
      `INSERT INTO customers (full_name, email, phone, id_number, id_type, kyc_status)
       VALUES ($1, $2, $3, $4, $5, $6) RETURNING *`,
      [full_name, email, phone, id_number, id_type, kyc_status || 'pending']
    );
    res.status(201).json(rows[0]);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.patch('/customers/:id/kyc', async (req, res) => {
  const { kyc_status } = req.body;
  try {
    const { rows } = await pool.query(
      `UPDATE customers SET kyc_status = $1, updated_at = NOW()
       WHERE id = $2 RETURNING *`,
      [kyc_status, req.params.id]
    );
    if (!rows.length) return res.status(404).json({ error: 'Customer not found' });
    res.json(rows[0]);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ══════════════════════════════════════════════════════════════════
//  TRANSACTIONS
// ══════════════════════════════════════════════════════════════════

app.get('/transactions', async (req, res) => {
  const { status, customer_id } = req.query;
  let query = 'SELECT * FROM transactions WHERE 1=1';
  const params = [];

  if (status) {
    params.push(status);
    query += ` AND status = $${params.length}`;
  }
  if (customer_id) {
    params.push(customer_id);
    query += ` AND sender_id = $${params.length}`;
  }

  query += ' ORDER BY created_at DESC';

  try {
    const { rows } = await pool.query(query, params);
    res.json(rows);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/transactions/:id', async (req, res) => {
  try {
    const { rows } = await pool.query(
      'SELECT * FROM transactions WHERE id = $1',
      [req.params.id]
    );
    if (!rows.length) return res.status(404).json({ error: 'Transaction not found' });
    res.json(rows[0]);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/transactions', async (req, res) => {
  const {
    sender_id, recipient_name, recipient_phone,
    recipient_country, amount, currency, exchange_rate, notes
  } = req.body;
  try {
    const { rows } = await pool.query(
      `INSERT INTO transactions
        (sender_id, recipient_name, recipient_phone, recipient_country,
         amount, currency, exchange_rate, status, notes)
       VALUES ($1,$2,$3,$4,$5,$6,$7,'pending',$8) RETURNING *`,
      [
        sender_id || null,
        recipient_name,
        recipient_phone || null,
        recipient_country || null,
        amount,
        currency || 'GMD',
        exchange_rate || null,
        notes || null
      ]
    );
    res.status(201).json(rows[0]);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ══════════════════════════════════════════════════════════════════
//  BOOKINGS
// ══════════════════════════════════════════════════════════════════

app.get('/bookings', async (req, res) => {
  const { status, date } = req.query;
  let query = 'SELECT * FROM bookings WHERE 1=1';
  const params = [];

  if (status) {
    params.push(status);
    query += ` AND status = $${params.length}`;
  }
  if (date) {
    params.push(date);
    query += ` AND booking_date = $${params.length}`;
  }

  query += ' ORDER BY booking_date ASC, booking_time ASC';

  try {
    const { rows } = await pool.query(query, params);
    res.json(rows);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/bookings', async (req, res) => {
  const { customer_id, service, booking_date, booking_time, notes } = req.body;
  try {
    const { rows } = await pool.query(
      `INSERT INTO bookings (customer_id, service, booking_date, booking_time, status, notes)
       VALUES ($1,$2,$3,$4,'pending',$5) RETURNING *`,
      [customer_id, service, booking_date, booking_time, notes]
    );
    res.status(201).json(rows[0]);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.patch('/bookings/:id', async (req, res) => {
  const { status, booking_date, booking_time } = req.body;
  try {
    const { rows } = await pool.query(
      `UPDATE bookings
       SET status = COALESCE($1, status),
           booking_date = COALESCE($2, booking_date),
           booking_time = COALESCE($3, booking_time),
           updated_at = NOW()
       WHERE id = $4 RETURNING *`,
      [status, booking_date, booking_time, req.params.id]
    );
    if (!rows.length) return res.status(404).json({ error: 'Booking not found' });
    res.json(rows[0]);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.delete('/bookings/:id', async (req, res) => {
  try {
    await pool.query(
      `UPDATE bookings SET status = 'cancelled', updated_at = NOW() WHERE id = $1`,
      [req.params.id]
    );
    res.json({ success: true, message: 'Booking cancelled' });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ─── Start Server ──────────────────────────────────────────────────────────
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Soni Transfer API running on port ${PORT}`));
