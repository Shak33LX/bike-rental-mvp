require("dotenv").config();

const crypto = require("crypto");
const express = require("express");
const cors = require("cors");
const admin = require("firebase-admin");
const Razorpay = require("razorpay");
const {
  S3Client,
  PutObjectCommand,
  HeadObjectCommand,
  GetObjectCommand,
} = require("@aws-sdk/client-s3");
const { getSignedUrl } = require("@aws-sdk/s3-request-presigner");

function parseAllowedOrigins() {
  const configured = (process.env.CORS_ORIGINS || "")
    .split(",")
    .map((value) => value.trim())
    .filter(Boolean);

  const defaults = [
    "https://bike-rental-mvp-eb787.web.app",
    "https://bike-rental-mvp-eb787.firebaseapp.com",
    "http://localhost:3000",
    "http://127.0.0.1:3000",
  ];

  return [...new Set([...defaults, ...configured])];
}

const app = express();
app.set("trust proxy", true);
app.use("/webhooks/razorpay", express.raw({ type: "application/json" }));
app.use(express.json({ limit: "10mb" }));
app.use(
  cors({
    origin: parseAllowedOrigins(),
  }),
);

const serviceAccount = require("./firebase-service-account.json");

admin.initializeApp({
  credential: admin.credential.cert(serviceAccount),
});

const db = admin.firestore();
const FieldValue = admin.firestore.FieldValue;

const s3 = new S3Client({
  region: process.env.AWS_REGION,
});

const razorpay = new Razorpay({
  key_id: process.env.RAZORPAY_KEY_ID,
  key_secret: process.env.RAZORPAY_KEY_SECRET,
});

const MAX_UPLOAD_BYTES = 10 * 1024 * 1024;
const ALLOWED_MIME_TYPES = new Set([
  "image/jpeg",
  "image/png",
  "image/webp",
  "application/pdf",
]);
const KYC_TYPES = new Set(["aadhaar", "license", "selfie", "address"]);
const PUBLIC_UPLOAD_PURPOSES = new Set(["listing"]);
const DAY_NAMES = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];
const DEFAULT_BIKE_CENTER = { lat: 12.897, lng: 80.004 };
const BIKE_PALETTE = [
  { color: "#E3F2FD", stroke: "#1565C0" },
  { color: "#E8F5E9", stroke: "#2E7D32" },
  { color: "#FFF8E1", stroke: "#F57F17" },
  { color: "#F3E5F5", stroke: "#6A1B9A" },
  { color: "#FCE4EC", stroke: "#C62828" },
  { color: "#E0F2F1", stroke: "#00695C" },
];

function sanitizeFileName(name = "upload.bin") {
  return name.replace(/[^a-zA-Z0-9._-]/g, "_").slice(0, 80) || "upload.bin";
}

function hashString(value = "") {
  let hash = 0;
  for (let i = 0; i < value.length; i += 1) {
    hash = (hash * 31 + value.charCodeAt(i)) % 1000003;
  }
  return hash;
}

function derivePalette(seed) {
  return BIKE_PALETTE[hashString(seed) % BIKE_PALETTE.length];
}

function deriveCoordinates(seed) {
  const hash = hashString(seed);
  const latOffset = ((hash % 41) - 20) / 10000;
  const lngOffset = (((Math.floor(hash / 41)) % 41) - 20) / 10000;
  return {
    lat: Number((DEFAULT_BIKE_CENTER.lat + latOffset).toFixed(6)),
    lng: Number((DEFAULT_BIKE_CENTER.lng + lngOffset).toFixed(6)),
  };
}

function normalizeSchedule(schedule = {}) {
  const fallbackDays = ["Mon", "Tue", "Wed", "Thu", "Fri"];
  const days = Array.isArray(schedule.days)
    ? schedule.days.filter((day) => DAY_NAMES.includes(day))
    : fallbackDays;
  return {
    days: days.length ? days : fallbackDays,
    from: typeof schedule.from === "string" && schedule.from ? schedule.from : "09:00",
    to: typeof schedule.to === "string" && schedule.to ? schedule.to : "17:00",
    minimumDuration:
      typeof schedule.minimumDuration === "string" && schedule.minimumDuration
        ? schedule.minimumDuration
        : "1 hour",
  };
}

function buildConditionState(conditionNotes = "") {
  const notes = String(conditionNotes || "").trim();
  return {
    conditionNotes: notes,
    conds: notes ? ["Owner listed bike"] : ["Fresh listing"],
    warn: notes ? [notes] : [],
  };
}

function buildSlots(from = "09:00", to = "17:00") {
  const parseHour = (value, fallback) => {
    const hour = Number(String(value).split(":")[0]);
    return Number.isFinite(hour) ? hour : fallback;
  };

  const startHour = parseHour(from, 9);
  const endHour = Math.max(parseHour(to, 17), startHour + 1);
  const slots = [];

  for (let hour = startHour; hour < endHour && slots.length < 8; hour += 1) {
    const next = hour + 1;
    const formatHour = (h) => {
      const normalized = ((h + 11) % 12) + 1;
      const suffix = h >= 12 && h < 24 ? "PM" : "AM";
      return `${normalized}${suffix}`;
    };
    slots.push({ t: `${formatHour(hour)}-${formatHour(next)}`, taken: false });
  }

  return slots.length ? slots : [{ t: "9AM-10AM", taken: false }];
}

async function getUserProfile(uid) {
  const userSnap = await db.collection("users").doc(uid).get();
  return userSnap.exists ? userSnap.data() : {};
}

function toCurrencyNumber(value, fallback = 0) {
  const number = Number(value);
  return Number.isFinite(number) ? number : fallback;
}

function buildListingDocument(payload, ownerContext) {
  const name = String(payload.name || payload.type || "").trim();
  if (!name) {
    throw new Error("Bike name is required.");
  }

  const price = toCurrencyNumber(payload.price, NaN);
  if (!Number.isFinite(price) || price <= 0) {
    throw new Error("A valid hourly price is required.");
  }

  const schedule = normalizeSchedule(payload.schedule);
  const palette = derivePalette(ownerContext.docId);
  const coords = deriveCoordinates(ownerContext.docId);
  const conditionState = buildConditionState(payload.conditionNotes);
  const regNo = String(payload.registrationNumber || payload.regNo || "").trim().toUpperCase();
  const bikeType = String(payload.bikeType || payload.category || "").trim() || "Bike";
  const contactNumber = String(payload.contactNumber || payload.ownerPhone || ownerContext.ownerPhone || "").trim();
  const photoUploadId = String(payload.photoUploadId || "").trim();

  return {
    name,
    bikeType,
    owner: ownerContext.ownerName,
    ownerUid: ownerContext.ownerUid,
    ownerEmail: ownerContext.ownerEmail,
    ownerPhone: contactNumber,
    contactNumber,
    price: Number(price.toFixed(2)),
    dist: toCurrencyNumber(payload.dist, 0.6),
    lat: toCurrencyNumber(payload.lat, coords.lat),
    lng: toCurrencyNumber(payload.lng, coords.lng),
    avail: payload.active === false ? false : true,
    active: payload.active === false ? false : true,
    approved: true,
    archived: false,
    color: payload.color || palette.color,
    stroke: payload.stroke || palette.stroke,
    schedule,
    minimumDuration: schedule.minimumDuration,
    regNo,
    photoUploadId: photoUploadId || null,
    slots: Array.isArray(payload.slots) && payload.slots.length ? payload.slots : buildSlots(schedule.from, schedule.to),
    rating: toCurrencyNumber(payload.rating, 0),
    reviewCount: Math.max(0, Math.round(toCurrencyNumber(payload.reviewCount, 0))),
    ridesCount: Math.max(0, Math.round(toCurrencyNumber(payload.ridesCount, 0))),
    ...conditionState,
    updatedAt: FieldValue.serverTimestamp(),
  };
}

function validateUpload({ purpose, docType, mimeType, size }) {
  if (!["kyc", "damage", "profile", "listing"].includes(purpose)) {
    throw new Error("Unsupported upload purpose.");
  }
  if (!docType || typeof docType !== "string") {
    throw new Error("Document type is required.");
  }
  if (!ALLOWED_MIME_TYPES.has(mimeType)) {
    throw new Error("Unsupported file type.");
  }
  if (!Number.isFinite(size) || size <= 0 || size > MAX_UPLOAD_BYTES) {
    throw new Error("File size exceeds the allowed limit.");
  }
  if (purpose === "kyc" && !KYC_TYPES.has(docType)) {
    throw new Error("Unsupported KYC document type.");
  }
}

function buildSignature(orderId, paymentId) {
  return crypto
    .createHmac("sha256", process.env.RAZORPAY_KEY_SECRET)
    .update(`${orderId}|${paymentId}`)
    .digest("hex");
}

function getUserMessage(error, fallback) {
  return error?.message || error?.code || fallback;
}

async function authMiddleware(req, res, next) {
  try {
    const authHeader = req.headers.authorization || "";
    const token = authHeader.startsWith("Bearer ") ? authHeader.slice(7) : null;
    if (!token) {
      return res.status(401).json({ error: "Missing auth token" });
    }
    req.user = await admin.auth().verifyIdToken(token);
    return next();
  } catch (error) {
    return res.status(401).json({ error: "Invalid auth token" });
  }
}

async function updateBikeSlotState(tx, bikeId, slotLabel) {
  const bikeRef = db.collection("bikes").doc(bikeId);
  const bikeSnap = await tx.get(bikeRef);
  if (!bikeSnap.exists) {
    throw new Error("Bike not found.");
  }

  const bikeData = bikeSnap.data();
  const slots = Array.isArray(bikeData.slots)
    ? bikeData.slots.map((slot) => ({ ...slot }))
    : [];
  const slotIndex = slots.findIndex((slot) => slot.t === slotLabel);

  if (slotIndex === -1) {
    throw new Error("Selected slot is no longer available.");
  }
  if (slots[slotIndex].taken) {
    throw new Error("Selected slot has already been booked.");
  }

  slots[slotIndex].taken = true;
  const hasFreeSlot = slots.some((slot) => !slot.taken);

  tx.update(bikeRef, {
    slots,
    avail: hasFreeSlot,
    updatedAt: FieldValue.serverTimestamp(),
  });

  return bikeData;
}

app.get("/health", (req, res) => {
  res.json({
    ok: true,
    service: "rideshare-api",
    hasS3Bucket: Boolean(process.env.S3_BUCKET),
    hasAwsRegion: Boolean(process.env.AWS_REGION),
    hasRazorpayKey: Boolean(process.env.RAZORPAY_KEY_ID),
    allowedOrigins: parseAllowedOrigins(),
  });
});

app.post("/bootstrap", authMiddleware, async (req, res) => {
  res.json({ ok: true, seeded: false });
});

app.post("/listings", authMiddleware, async (req, res) => {
  try {
    const profile = await getUserProfile(req.user.uid);
    const listingRef = db.collection("bikes").doc();
    const listing = buildListingDocument(req.body || {}, {
      docId: listingRef.id,
      ownerUid: req.user.uid,
      ownerName:
        profile.fullName ||
        profile.displayName ||
        req.user.name ||
        req.user.email?.split("@")[0] ||
        "Owner",
      ownerEmail: req.user.email || profile.email || "",
      ownerPhone: profile.phone || "",
    });

    await listingRef.set({
      ...listing,
      createdAt: FieldValue.serverTimestamp(),
    });

    res.json({ ok: true, bikeId: listingRef.id });
  } catch (error) {
    console.error("create listing error", error);
    res.status(500).json({ error: getUserMessage(error, "Unable to create the listing.") });
  }
});

app.patch("/listings/:bikeId", authMiddleware, async (req, res) => {
  try {
    const bikeRef = db.collection("bikes").doc(req.params.bikeId);
    const bikeSnap = await bikeRef.get();
    if (!bikeSnap.exists) {
      return res.status(404).json({ error: "Listing not found." });
    }

    const bike = bikeSnap.data();
    if (bike.ownerUid !== req.user.uid) {
      return res.status(403).json({ error: "You do not own this listing." });
    }

    const updates = { updatedAt: FieldValue.serverTimestamp() };

    if (req.body.name || req.body.type) {
      updates.name = String(req.body.name || req.body.type).trim();
    }
    if (req.body.bikeType !== undefined) {
      updates.bikeType = String(req.body.bikeType || "").trim() || bike.bikeType || "Bike";
    }
    if (req.body.registrationNumber || req.body.regNo) {
      updates.regNo = String(req.body.registrationNumber || req.body.regNo).trim().toUpperCase();
    }
    if (req.body.contactNumber !== undefined) {
      const contactNumber = String(req.body.contactNumber || "").trim();
      updates.contactNumber = contactNumber;
      updates.ownerPhone = contactNumber;
    }
    if (req.body.price !== undefined) {
      const price = toCurrencyNumber(req.body.price, NaN);
      if (!Number.isFinite(price) || price <= 0) {
        return res.status(400).json({ error: "A valid hourly price is required." });
      }
      updates.price = Number(price.toFixed(2));
    }
    if (req.body.photoUploadId !== undefined) {
      updates.photoUploadId = String(req.body.photoUploadId || "").trim() || null;
    }
    if (req.body.conditionNotes !== undefined) {
      Object.assign(updates, buildConditionState(req.body.conditionNotes));
    }
    if (req.body.active !== undefined) {
      updates.active = Boolean(req.body.active);
      updates.avail = Boolean(req.body.active) && (Array.isArray(bike.slots) ? bike.slots.some((slot) => !slot.taken) : true);
    }
    if (req.body.schedule) {
      const schedule = normalizeSchedule(req.body.schedule);
      updates.schedule = schedule;
      updates.minimumDuration = schedule.minimumDuration;
      updates.slots = buildSlots(schedule.from, schedule.to);
      if (updates.active === undefined) {
        updates.avail = bike.active !== false;
      }
    }

    await bikeRef.update(updates);
    res.json({ ok: true });
  } catch (error) {
    console.error("update listing error", error);
    res.status(500).json({ error: getUserMessage(error, "Unable to update the listing.") });
  }
});

app.patch("/listings/:bikeId/toggle", authMiddleware, async (req, res) => {
  try {
    const active = Boolean(req.body?.active);
    const bikeRef = db.collection("bikes").doc(req.params.bikeId);
    const bikeSnap = await bikeRef.get();
    if (!bikeSnap.exists) {
      return res.status(404).json({ error: "Listing not found." });
    }

    const bike = bikeSnap.data();
    if (bike.ownerUid !== req.user.uid) {
      return res.status(403).json({ error: "You do not own this listing." });
    }

    await bikeRef.update({
      active,
      avail: active && (Array.isArray(bike.slots) ? bike.slots.some((slot) => !slot.taken) : true),
      updatedAt: FieldValue.serverTimestamp(),
    });

    res.json({ ok: true });
  } catch (error) {
    console.error("toggle listing error", error);
    res.status(500).json({ error: getUserMessage(error, "Unable to update the listing state.") });
  }
});

app.delete("/listings/:bikeId", authMiddleware, async (req, res) => {
  try {
    const bikeRef = db.collection("bikes").doc(req.params.bikeId);
    const bikeSnap = await bikeRef.get();
    if (!bikeSnap.exists) {
      return res.status(404).json({ error: "Listing not found." });
    }

    if (bikeSnap.data().ownerUid !== req.user.uid) {
      return res.status(403).json({ error: "You do not own this listing." });
    }

    await bikeRef.update({
      archived: true,
      active: false,
      avail: false,
      updatedAt: FieldValue.serverTimestamp(),
    });

    res.json({ ok: true });
  } catch (error) {
    console.error("delete listing error", error);
    res.status(500).json({ error: getUserMessage(error, "Unable to remove the listing.") });
  }
});

app.post("/upload/create-session", authMiddleware, async (req, res) => {
  try {
    const { purpose, docType, mimeType, size, fileName } = req.body || {};
    validateUpload({ purpose, docType, mimeType, size });

    const uploadRef = db.collection("fileUploads").doc();
    const cleanName = sanitizeFileName(fileName);
    const objectKey = `private/${req.user.uid}/${purpose}/${uploadRef.id}/${cleanName}`;
    const uploadUrl = await getSignedUrl(
      s3,
      new PutObjectCommand({
        Bucket: process.env.S3_BUCKET,
        Key: objectKey,
        ContentType: mimeType,
        Metadata: {
          uid: req.user.uid,
          purpose,
          docType,
          uploadid: uploadRef.id,
        },
      }),
      { expiresIn: 300 },
    );

    await uploadRef.set({
      ownerUid: req.user.uid,
      purpose,
      docType,
      fileName: cleanName,
      mimeType,
      size,
      s3Bucket: process.env.S3_BUCKET,
      s3Key: objectKey,
      status: "uploading",
      createdAt: FieldValue.serverTimestamp(),
    });

    res.json({
      uploadId: uploadRef.id,
      uploadUrl,
      s3Key: objectKey,
    });
  } catch (error) {
    console.error("create-session error", error);
    res.status(500).json({ error: getUserMessage(error, "Failed to create upload session") });
  }
});

app.post("/upload/finalize", authMiddleware, async (req, res) => {
  try {
    const { uploadId } = req.body || {};
    if (!uploadId) {
      return res.status(400).json({ error: "Upload id is required." });
    }

    const uploadRef = db.collection("fileUploads").doc(uploadId);
    const uploadSnap = await uploadRef.get();
    if (!uploadSnap.exists) {
      return res.status(404).json({ error: "Upload session not found." });
    }

    const uploadData = uploadSnap.data();
    if (uploadData.ownerUid !== req.user.uid) {
      return res.status(403).json({ error: "You do not own this upload." });
    }

    const head = await s3.send(
      new HeadObjectCommand({
        Bucket: uploadData.s3Bucket,
        Key: uploadData.s3Key,
      }),
    );

    await uploadRef.update({
      status: "uploaded",
      etag: head.ETag || null,
      uploadedAt: FieldValue.serverTimestamp(),
    });

    if (uploadData.purpose === "kyc") {
      await db
        .collection("users")
        .doc(req.user.uid)
        .set(
          {
            kyc: {
              [uploadData.docType]: {
                uploadId,
                status: "pending_review",
                mimeType: uploadData.mimeType,
                fileName: uploadData.fileName,
                s3Key: uploadData.s3Key,
                uploadedAt: new Date().toISOString(),
              },
            },
          },
          { merge: true },
        );

      await uploadRef.update({ status: "pending_review" });
    }

    if (uploadData.purpose === "profile") {
      await db.collection("users").doc(req.user.uid).set(
        {
          photoUploadId: uploadId,
          photoMimeType: uploadData.mimeType,
          photoUpdatedAt: new Date().toISOString(),
        },
        { merge: true },
      );
    }

    res.json({
      ok: true,
      uploadId,
      status: uploadData.purpose === "kyc" ? "pending_review" : "uploaded",
    });
  } catch (error) {
    console.error("finalize error", error);
    res.status(500).json({ error: getUserMessage(error, "Failed to finalize upload") });
  }
});

app.get("/upload/download-url/:uploadId", authMiddleware, async (req, res) => {
  try {
    const uploadSnap = await db.collection("fileUploads").doc(req.params.uploadId).get();
    if (!uploadSnap.exists) {
      return res.status(404).json({ error: "File not found." });
    }

    const uploadData = uploadSnap.data();
    if (uploadData.ownerUid !== req.user.uid && !PUBLIC_UPLOAD_PURPOSES.has(uploadData.purpose)) {
      return res.status(403).json({ error: "You do not have access to this file." });
    }

    const url = await getSignedUrl(
      s3,
      new GetObjectCommand({
        Bucket: uploadData.s3Bucket,
        Key: uploadData.s3Key,
      }),
      { expiresIn: 300 },
    );

    res.json({ url });
  } catch (error) {
    console.error("download-url error", error);
    res.status(500).json({ error: getUserMessage(error, "Failed to create download URL") });
  }
});

app.post("/payments/booking/create-order", authMiddleware, async (req, res) => {
  try {
    const { bikeId, slot } = req.body || {};
    if (!bikeId || !slot) {
      return res.status(400).json({ error: "Bike id and slot are required." });
    }

    const bikeSnap = await db.collection("bikes").doc(bikeId).get();
    if (!bikeSnap.exists) {
      return res.status(404).json({ error: "Bike not found." });
    }

    const bike = bikeSnap.data();
    if (bike.archived || bike.active === false) {
      return res.status(409).json({ error: "This listing is currently unavailable." });
    }
    const slotData = Array.isArray(bike.slots) ? bike.slots.find((item) => item.t === slot) : null;
    if (!slotData || slotData.taken || !bike.avail) {
      return res.status(409).json({ error: "This slot is no longer available." });
    }

    const baseAmount = Number(bike.price || 0);
    const totalAmount = Number((baseAmount * 1.08).toFixed(2));
    const amountPaise = Math.round(totalAmount * 100);
    const bookingRef = db.collection("bookings").doc();
    const renterProfile = await getUserProfile(req.user.uid);

    const order = await razorpay.orders.create({
      amount: amountPaise,
      currency: "INR",
      receipt: bookingRef.id,
      notes: {
        bookingId: bookingRef.id,
        bikeId,
        slot,
        uid: req.user.uid,
      },
    });

    await bookingRef.set({
      userId: req.user.uid,
      userName:
        renterProfile.fullName ||
        renterProfile.displayName ||
        req.user.name ||
        req.user.email?.split("@")[0] ||
        "Renter",
      userEmail: req.user.email || renterProfile.email || "",
      bikeId,
      bikeName: bike.name,
      owner: bike.owner,
      ownerUid: bike.ownerUid || null,
      ownerPhone: bike.ownerPhone || "",
      slot,
      price: baseAmount,
      platformFee: Number((totalAmount - baseAmount).toFixed(2)),
      total: totalAmount,
      razorpayOrderId: order.id,
      paymentStatus: "created",
      status: "pending_payment",
      createdAt: FieldValue.serverTimestamp(),
    });

    await db.collection("payments").doc(order.id).set({
      bookingId: bookingRef.id,
      userId: req.user.uid,
      ownerUid: bike.ownerUid || null,
      kind: "booking",
      amountPaise,
      currency: "INR",
      status: "created",
      createdAt: FieldValue.serverTimestamp(),
    });

    res.json({
      bookingId: bookingRef.id,
      orderId: order.id,
      amount: amountPaise,
      total: totalAmount,
      currency: "INR",
      keyId: process.env.RAZORPAY_KEY_ID,
    });
  } catch (error) {
    console.error("create booking order error", error);
    res.status(500).json({ error: getUserMessage(error, "Unable to create booking order.") });
  }
});

app.post("/payments/booking/verify", authMiddleware, async (req, res) => {
  try {
    const { bookingId, orderId, paymentId, signature } = req.body || {};
    if (!bookingId || !orderId || !paymentId || !signature) {
      return res.status(400).json({ error: "Missing payment verification details." });
    }
    if (buildSignature(orderId, paymentId) !== signature) {
      return res.status(403).json({ error: "Invalid payment signature." });
    }

    await db.runTransaction(async (tx) => {
      const bookingRef = db.collection("bookings").doc(bookingId);
      const bookingSnap = await tx.get(bookingRef);
      if (!bookingSnap.exists) {
        throw new Error("Booking not found.");
      }

      const booking = bookingSnap.data();
      if (booking.userId !== req.user.uid) {
        throw new Error("You do not own this booking.");
      }

      await updateBikeSlotState(tx, booking.bikeId, booking.slot);

      tx.update(bookingRef, {
        paymentStatus: "captured",
        status: "active",
        razorpayPaymentId: paymentId,
        updatedAt: FieldValue.serverTimestamp(),
      });

      tx.set(
        db.collection("payments").doc(orderId),
        {
          bookingId,
          userId: req.user.uid,
          kind: "booking",
          razorpayPaymentId: paymentId,
          status: "captured",
          capturedAt: FieldValue.serverTimestamp(),
        },
        { merge: true },
      );
    });

    res.json({ ok: true });
  } catch (error) {
    console.error("verify booking payment error", error);
    res.status(500).json({ error: getUserMessage(error, "Unable to verify booking payment.") });
  }
});

app.post("/payments/damage/create-order", authMiddleware, async (req, res) => {
  try {
    const { reportId, amount } = req.body || {};
    if (!reportId || !Number.isFinite(amount) || amount <= 0) {
      return res.status(400).json({ error: "A valid report id and amount are required." });
    }

    const reportRef = db.collection("damage_reports").doc(reportId);
    const reportSnap = await reportRef.get();
    if (!reportSnap.exists) {
      return res.status(404).json({ error: "Damage report not found." });
    }

    const report = reportSnap.data();
    if (report.userId !== req.user.uid) {
      return res.status(403).json({ error: "You do not own this damage report." });
    }

    const amountPaise = Math.round(Number(amount) * 100);
    const order = await razorpay.orders.create({
      amount: amountPaise,
      currency: "INR",
      receipt: reportId,
      notes: {
        reportId,
        uid: req.user.uid,
      },
    });

    await reportRef.set(
      {
        estimatedLiability: Number(amount),
        damagePaymentStatus: "created",
        damageOrderId: order.id,
        updatedAt: FieldValue.serverTimestamp(),
      },
      { merge: true },
    );

    await db.collection("payments").doc(order.id).set({
      reportId,
      userId: req.user.uid,
      kind: "damage",
      amountPaise,
      currency: "INR",
      status: "created",
      createdAt: FieldValue.serverTimestamp(),
    });

    res.json({
      orderId: order.id,
      amount: amountPaise,
      currency: "INR",
      keyId: process.env.RAZORPAY_KEY_ID,
    });
  } catch (error) {
    console.error("create damage order error", error);
    res.status(500).json({ error: getUserMessage(error, "Unable to create damage payment order.") });
  }
});

app.post("/payments/damage/verify", authMiddleware, async (req, res) => {
  try {
    const { reportId, orderId, paymentId, signature } = req.body || {};
    if (!reportId || !orderId || !paymentId || !signature) {
      return res.status(400).json({ error: "Missing payment verification details." });
    }
    if (buildSignature(orderId, paymentId) !== signature) {
      return res.status(403).json({ error: "Invalid payment signature." });
    }

    const reportRef = db.collection("damage_reports").doc(reportId);
    const reportSnap = await reportRef.get();
    if (!reportSnap.exists) {
      return res.status(404).json({ error: "Damage report not found." });
    }

    const report = reportSnap.data();
    if (report.userId !== req.user.uid) {
      return res.status(403).json({ error: "You do not own this damage report." });
    }

    await reportRef.set(
      {
        damagePaymentStatus: "paid",
        damagePaymentId: paymentId,
        updatedAt: FieldValue.serverTimestamp(),
      },
      { merge: true },
    );

    await db.collection("payments").doc(orderId).set(
      {
        reportId,
        userId: req.user.uid,
        kind: "damage",
        razorpayPaymentId: paymentId,
        status: "captured",
        capturedAt: FieldValue.serverTimestamp(),
      },
      { merge: true },
    );

    res.json({ ok: true });
  } catch (error) {
    console.error("verify damage payment error", error);
    res.status(500).json({ error: getUserMessage(error, "Unable to verify damage payment.") });
  }
});

app.post("/bank/save", authMiddleware, async (req, res) => {
  try {
    const { holderName, accountNumber, ifsc, bankName, upi } = req.body || {};
    if (!holderName || !ifsc) {
      return res.status(400).json({ error: "Account holder name and IFSC are required." });
    }

    await db.collection("users").doc(req.user.uid).set(
      {
        bankAccount: {
          holderName,
          accountNumber: accountNumber || "",
          ifsc,
          bankName: bankName || "",
          upi: upi || "",
          updatedAt: new Date().toISOString(),
        },
      },
      { merge: true },
    );

    res.json({ ok: true });
  } catch (error) {
    console.error("save bank error", error);
    res.status(500).json({ error: getUserMessage(error, "Unable to save bank details.") });
  }
});

app.post("/withdrawals/request", authMiddleware, async (req, res) => {
  try {
    const { amount } = req.body || {};
    if (!Number.isFinite(amount) || amount <= 0) {
      return res.status(400).json({ error: "A valid withdrawal amount is required." });
    }

    const userSnap = await db.collection("users").doc(req.user.uid).get();
    const bankAccount = userSnap.exists ? userSnap.data().bankAccount : null;
    if (!bankAccount || !bankAccount.holderName || !bankAccount.ifsc) {
      return res.status(409).json({ error: "Please add your bank details before requesting a withdrawal." });
    }

    const requestRef = db.collection("withdrawal_requests").doc();
    await requestRef.set({
      userId: req.user.uid,
      amount: Number(amount),
      status: "pending",
      bankAccount,
      createdAt: FieldValue.serverTimestamp(),
    });

    res.json({
      ok: true,
      requestId: requestRef.id,
    });
  } catch (error) {
    console.error("withdrawal request error", error);
    res.status(500).json({ error: getUserMessage(error, "Unable to request withdrawal.") });
  }
});

app.post("/webhooks/razorpay", async (req, res) => {
  try {
    if (!process.env.RAZORPAY_WEBHOOK_SECRET) {
      return res.status(500).send("Webhook secret is not configured");
    }

    const signature = req.get("x-razorpay-signature");
    const eventId = req.get("x-razorpay-event-id") || crypto.randomUUID();
    const expected = crypto
      .createHmac("sha256", process.env.RAZORPAY_WEBHOOK_SECRET)
      .update(req.body)
      .digest("hex");

    if (signature !== expected) {
      return res.status(400).send("Invalid signature");
    }

    const eventRef = db.collection("webhookEvents").doc(eventId);
    const eventSnap = await eventRef.get();
    if (eventSnap.exists) {
      return res.status(200).send("Duplicate");
    }

    const body = JSON.parse(req.body.toString("utf8"));
    const event = body.event;
    const paymentEntity = body.payload?.payment?.entity || null;
    const orderId = paymentEntity?.order_id || null;

    if (orderId) {
      const paymentUpdate = {
        webhookEvent: event,
        webhookReceivedAt: FieldValue.serverTimestamp(),
      };

      if (event === "payment.captured") {
        paymentUpdate.status = "captured";
      } else if (event === "payment.failed") {
        paymentUpdate.status = "failed";
        paymentUpdate.failureReason = paymentEntity.error_description || "";
      }

      await db.collection("payments").doc(orderId).set(paymentUpdate, { merge: true });
    }

    await eventRef.set({
      event,
      createdAt: FieldValue.serverTimestamp(),
    });

    res.status(200).send("ok");
  } catch (error) {
    console.error("webhook error", error);
    res.status(500).send("Webhook processing failed");
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`rideshare-api listening on port ${PORT}`);
});
