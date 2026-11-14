require("dotenv").config();
const path = require("path");
const express = require("express");
const rateLimit = require("express-rate-limit");
const nodemailer = require("nodemailer");

const app = express();

// Trust reverse proxy (Vercel, Render, Railway, Nginx) for accurate IP rate limiting
app.set("trust proxy", 1);

// CORS support for API consumers and cross-origin testing
app.use((req, res, next) => {
  res.header("Access-Control-Allow-Origin", "*");
  res.header("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  res.header("Access-Control-Allow-Headers", "Content-Type, Authorization");
  if (req.method === "OPTIONS") return res.sendStatus(200);
  next();
});

app.use(express.json({ limit: "20kb" }));
app.use(express.static(path.join(__dirname, "public")));

// Optional: save messages to MongoDB when MONGODB_URI is set
let Message = null;
let mongooseInstance = null;
if (process.env.MONGODB_URI) {
  const mongoose = require("mongoose");
  mongooseInstance = mongoose;
  mongoose
    .connect(process.env.MONGODB_URI)
    .then(() => console.log("MongoDB connected"))
    .catch((err) => console.error("MongoDB error:", err.message));
  Message = mongoose.model(
    "Message",
    new mongoose.Schema(
      { name: String, email: String, message: String },
      { timestamps: true }
    )
  );
}

// Clean and validate email credentials
const rawPass = process.env.EMAIL_PASS || "";
const cleanPass = rawPass.replace(/\s+/g, ""); // Strip whitespace from Gmail app passwords
const isPlaceholderPass =
  !cleanPass ||
  cleanPass.startsWith("your-") ||
  cleanPass.includes("app-password") ||
  cleanPass === "your-gmail-app-password" ||
  cleanPass === "your-16-character-app-password";

const hasEmailConfig = Boolean(process.env.EMAIL_USER && !isPlaceholderPass);

const transporter = hasEmailConfig
  ? nodemailer.createTransport({
      service: "gmail",
      auth: { user: process.env.EMAIL_USER, pass: cleanPass },
    })
  : null;

const limiter = rateLimit({ windowMs: 15 * 60 * 1000, max: 5 });
const escapeHtml = (t) =>
  String(t).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

const contactHandler = async (req, res) => {
  const { name, email, message, website } = req.body || {};
  if (website) return res.json({ ok: true }); // honeypot: bots fill this field
  if (!name || !message || !/^\S+@\S+\.\S+$/.test(email || "")) {
    return res.status(400).json({ error: "Enter your name, a valid email and a message." });
  }
  if (name.length > 100 || email.length > 200 || message.length > 5000) {
    return res.status(400).json({ error: "One of the fields is too long." });
  }
  try {
    // Only attempt MongoDB persistence if connection is ready (avoids hanging on timeout)
    if (Message && mongooseInstance && mongooseInstance.connection.readyState === 1) {
      await Message.create({ name, email, message }).catch((err) =>
        console.error("MongoDB save error:", err.message)
      );
    }

    if (transporter && hasEmailConfig) {
      await transporter.sendMail({
        from: `"Portfolio Contact" <${process.env.EMAIL_USER}>`,
        to: process.env.EMAIL_TO || process.env.EMAIL_USER,
        replyTo: email,
        subject: `New portfolio message from ${name}`,
        text: `Name: ${name}\nEmail: ${email}\n\n${message}`,
        html: `<p><b>Name:</b> ${escapeHtml(name)}</p><p><b>Email:</b> ${escapeHtml(email)}</p><p>${escapeHtml(message).replace(/\n/g, "<br>")}</p>`,
      });
      res.json({ ok: true, sent: true });
    } else {
      console.log(`\n📨 [CONTACT FORM RECEIVED - DEV MODE]`);
      console.log(`From: ${name} <${email}>`);
      console.log(`Message: ${message}`);
      console.log(`Note: Configure EMAIL_USER and EMAIL_PASS in .env to deliver real emails to inbox.\n`);
      res.json({ ok: true, devMode: true, note: "Message logged successfully (configure EMAIL_PASS in .env for inbox delivery)." });
    }
  } catch (err) {
    console.error("Contact error:", err.message);
    res.status(500).json({ error: "The message could not be sent: " + err.message });
  }
};

// Route matching for local Express and Vercel serverless functions
app.post(["/api/contact", "/contact", "/"], limiter, contactHandler);

if (require.main === module) {
  const PORT = process.env.PORT || 3000;
  app.listen(PORT, () => console.log(`Server running on http://localhost:${PORT}`));
}

module.exports = app;
