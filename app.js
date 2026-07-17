require('dotenv').config({ quiet: true });
const express = require('express');
const cors = require('cors');
const dealsRoutes = require('./routes/deals');
const leadsRoutes = require('./routes/leads');
const requestLogger = require('./middleware/requestLogger');

const app = express();

app.use(cors());
app.use(express.json());
app.use(requestLogger);

app.get('/health', (req, res) => res.json({ status: 'ok' }));

app.use('/', dealsRoutes);
app.use('/', leadsRoutes);

module.exports = app;