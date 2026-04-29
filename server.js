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

// GET all customers
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

// GET customer by phone number
// ⚠️ Must be BEFORE /customers/:id to avoid conflict
app.get('/customers/phone/:phone', async (req, res) => {
  try {
    const { rows } = await pool.query(
      'SELECT * FROM customers WHERE phone ILIKE $1',
      [`%${req.params.phone}%`]
    );
    if (!rows.length) return res.status(404).json({ error: 'Customer not found' });
    res.json(rows[0]);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET single customer by ID
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

// POST create customer
app.post('/customers', async (req, res) => {
  const { full_name, email, phone, id_number, id_type, kyc_status } = req.body;
  try {
    const { rows } = await pool.query(
      `INSERT INTO customers (full_name, email, phone, id_number, id_type, kyc_status)
       VALUES ($1, $2, $3, $4, $5, $6) RETURNING *`,
      [full_name, email || null, phone || null, id_number || null, id_type || null, kyc_status || 'pending']
    );
    res.status(201).json(rows[0]);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// PATCH update full customer profile + KYC status
// ⚠️ Must be BEFORE /customers/:id/kyc to avoid conflict
app.patch('/customers/:id', async (req, res) => {
  const { kyc_status, email, id_number, id_type, full_name, phone } = req.body;
  try {
    const { rows } = await pool.query(
      `UPDATE customers
       SET kyc_status = COALESCE($1, kyc_status),
           email = COALESCE($2, email),
           id_number = COALESCE($3, id_number),
           id_type = COALESCE($4, id_type),
           full_name = COALESCE($5, full_name),
           phone = COALESCE($6, phone),
           updated_at = NOW()
       WHERE id = $7 RETURNING *`,
      [kyc_status || null, email || null, id_number || null, id_type || null, full_name || null, phone || null, req.params.id]
    );
    if (!rows.length) return res.status(404).json({ error: 'Customer not found' });
    res.json(rows[0]);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// PATCH update KYC status only
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

// GET all transactions (filter by status, customer_id, recipient_name)
app.get('/transactions', async (req, res) => {
  const { status, customer_id, recipient_name } = req.query;
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
  if (recipient_name) {
    params.push(`%${recipient_name}%`);
    query += ` AND recipient_name ILIKE $${params.length}`;
  }

  query += ' ORDER BY created_at DESC';

  try {
    const { rows } = await pool.query(query, params);
    res.json(rows);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// PATCH cancel transaction by recipient name or customer ID
// ⚠️ Must be BEFORE /transactions/:id routes to avoid conflict
app.patch('/transactions/cancel', async (req, res) => {
  const { recipient_name, customer_id } = req.body;
  let query = `UPDATE transactions SET status = 'cancelled', updated_at = NOW()
               WHERE status = 'pending'`;
  const params = [];

  if (recipient_name) {
    params.push(`%${recipient_name}%`);
    query += ` AND recipient_name ILIKE $${params.length}`;
  }
  if (customer_id) {
    params.push(customer_id);
    query += ` AND sender_id = $${params.length}`;
  }

  query += ' RETURNING *';

  try {
    const { rows } = await pool.query(query, params);
    if (!rows.length) return res.status(404).json({
      error: 'No pending transaction found for that recipient'
    });
    res.json({ success: true, transaction: rows[0] });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET single transaction by ID
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

// POST create transaction
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

// PATCH update transaction status by ID
app.patch('/transactions/:id/status', async (req, res) => {
  const { status } = req.body;
  try {
    const { rows } = await pool.query(
      `UPDATE transactions SET status = $1, updated_at = NOW()
       WHERE id = $2 RETURNING *`,
      [status, req.params.id]
    );
    if (!rows.length) return res.status(404).json({ error: 'Transaction not found' });
    res.json(rows[0]);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// PATCH cancel transaction by ID (only pending)
app.patch('/transactions/:id/cancel', async (req, res) => {
  try {
    const { rows } = await pool.query(
      `UPDATE transactions SET status = 'cancelled', updated_at = NOW()
       WHERE id = $1 AND status = 'pending' RETURNING *`,
      [req.params.id]
    );
    if (!rows.length) return res.status(404).json({
      error: 'Transaction not found or cannot be cancelled. Only pending transactions can be cancelled.'
    });
    res.json({ success: true, transaction: rows[0] });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ══════════════════════════════════════════════════════════════════
//  BOOKINGS
// ══════════════════════════════════════════════════════════════════

// GET all bookings (filter by status, date)
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

// PATCH cancel booking by date or service (no ID needed)
// ⚠️ Must be BEFORE /bookings/:id routes to avoid conflict
app.patch('/bookings/cancel', async (req, res) => {
  const { customer_id, booking_date, service } = req.body;
  let query = `UPDATE bookings SET status = 'cancelled', updated_at = NOW()
               WHERE status != 'cancelled'`;
  const params = [];

  if (customer_id) {
    params.push(customer_id);
    query += ` AND customer_id = $${params.length}`;
  }
  if (booking_date) {
    params.push(booking_date);
    query += ` AND booking_date = $${params.length}`;
  }
  if (service) {
    params.push(`%${service}%`);
    query += ` AND service ILIKE $${params.length}`;
  }

  query += ' RETURNING *';

  try {
    const { rows } = await pool.query(query, params);
    if (!rows.length) return res.status(404).json({ error: 'No matching booking found' });
    res.json({ success: true, booking: rows[0] });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST create booking
app.post('/bookings', async (req, res) => {
  const { customer_id, service, booking_date, booking_time, notes } = req.body;
  try {
    const { rows } = await pool.query(
      `INSERT INTO bookings (customer_id, service, booking_date, booking_time, status, notes)
       VALUES ($1,$2,$3,$4,'pending',$5) RETURNING *`,
      [customer_id || null, service, booking_date, booking_time, notes || null]
    );
    res.status(201).json(rows[0]);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// PATCH update/reschedule booking by ID
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

// DELETE cancel booking by ID
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
