require('dotenv').config({ quiet: true });
const express = require('express');
const cors = require('cors');
const dealsRoutes = require('./routes/deals');

const app = express();

app.use(cors());
app.use(express.json());

app.get('/health', (req, res) => res.json({ status: 'ok' }));

app.use('/', dealsRoutes);

module.exports = app;