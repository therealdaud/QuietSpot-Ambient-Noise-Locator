require('dotenv').config();
const express = require('express');
const mongoose = require('mongoose');
const cors = require('cors');

const app = express();

// Middleware
app.use(cors());
app.use(express.json());

// Connect to MongoDB using the URI from .env
mongoose.connect(process.env.MONGODB_URI, {
  useNewUrlParser: true,
  useUnifiedTopology: true,
}).then(() => {
  console.log('Connected to MongoDB');
}).catch((error) => {
  console.error('Error connecting to MongoDB:', error);
});

// Define a marker schema
const markerSchema = new mongoose.Schema({
  latitude: Number,
  longitude: Number,
  title: String,
  description: String,
  noiseLevel: Number,
});

const Marker = mongoose.model('Marker', markerSchema);

// Endpoint to save marker data
app.post('/api/markers', async (req, res) => {
  const { latitude, longitude, title, description, noiseLevel } = req.body;

  const newMarker = new Marker({ latitude, longitude, title, description, noiseLevel });

  try {
    await newMarker.save();
    res.status(201).json({ message: 'Marker saved successfully' });
  } catch (error) {
    res.status(500).json({ message: 'Error saving marker', error });
  }
});

const PORT = process.env.PORT || 5000;
app.listen(PORT, () => {
  console.log(`Server is running on port ${PORT}`);
});

