/**
 * Option B: dynamic Stripe Checkout Sessions, integrated with the
 * sales page in public/index.html and public/thank-you-page.html.
 *
 * This server does two things:
 *  1. Serves the two HTML pages as static files.
 *  2. Exposes the API routes the sales page calls to start checkout,
 *     and the webhook route Stripe calls to confirm payment.
 *
 * Setup:
 *   npm install
 *   cp .env.example .env   (then fill in your real values)
 *   npm start
 *   open http://localhost:3000
 */

const test = require('dotenv').config();
const path = require('path');
const express = require('express');
const Stripe = require('stripe');

const fs = require('fs');
const https = require('https');
const cloudinary = require('cloudinary').v2;
// require("./cloudinary.js")



const stripe = Stripe(process.env.STRIPE_SECRET_KEY); // server-side only, never sent to the browser

const app = express();

/* ============================================================
   CLOUDINARY
   ============================================================ */

cloudinary.config({
  cloud_name: process.env.CLOUDINARY_CLOUD_NAME,
  api_key: process.env.CLOUDINARY_API_KEY,
  api_secret: process.env.CLOUDINARY_API_SECRET,
 pdf_public_id : process.env.CLOUDINARY_PDF_PUBLIC_ID
});

// Download and save the file locally to your server
// const file = fs.createWriteStream("./downloads/my_file.pdf");
// https.get(url, function(response) {
//    response.pipe(file);
//    console.log("PDF downloaded successfully!");
// });



// IMPORTANT: the webhook route needs the raw request body to verify
// Stripe's signature, so it must be registered BEFORE express.json()
// and before express.static() (static doesn't interfere, but keep
// the ordering so this rule is never accidentally broken later).

app.post(
  '/api/stripe-webhook',
  express.raw({ type: 'application/json' }),
  (req, res) => {
    const signature = req.headers['stripe-signature'];
    let event;

    try {
      event = stripe.webhooks.constructEvent(
        req.body,
        signature,
        process.env.STRIPE_WEBHOOK_SECRET // server-side only, never sent to the browser
      );
    } catch (err) {
      console.error('Webhook signature verification failed:', err.message);
      return res.status(400).send(`Webhook Error: ${err.message}`);
    }

    // This is the ONLY place payment should be treated as verified.
    // Do not treat a browser reaching the thank-you page as proof of
    // payment — that page is for customer experience only.
    if (event.type === 'checkout.session.completed') {
      const session = event.data.object;
      // TODO: mark the order as paid in your database, and/or generate
      // a real, expiring download link and email it to
      // session.customer_details.email.
      console.log('Payment verified for session:', session.id);
    }

    res.json({ received: true });
  }
);

app.use(express.json());

// Serves index.html and thank-you-page.html at "/" and "/thank-you-page.html".
app.use(express.static(path.join(__dirname, 'public')));

app.post('/api/create-checkout-session', async (req, res) => {
  try {
    const session = await stripe.checkout.sessions.create({
      mode: 'payment',
      line_items: [
        {
          price: process.env.STRIPE_PRICE_ID, // set in Stripe Dashboard → Product → Price
          quantity: 1,
        },
      ],
      success_url: `${process.env.THANK_YOU_URL}?session_id={CHECKOUT_SESSION_ID}`,
      cancel_url: process.env.SALES_PAGE_URL,
    });

    res.json({ url: session.url });
  } catch (err) {
    // Never leak stack traces or Stripe error internals to the client.
    console.error('Failed to create checkout session:', err.message);
    res.status(500).json({ error: 'Something went wrong while opening checkout. Please try again.' });
  }
});


/* ============================================================
   NORMAL JSON BODY PARSER
   ============================================================ */

app.use(express.json());


/* ============================================================
   STATIC WEBSITE
   ============================================================ */

app.use(
  express.static(
    path.join(__dirname, "public")
  )
);

/* ============================================================
   CLOUDINARY PDF DOWNLOAD
   ============================================================

   Customer visits:

   /download?session_id=cs_xxxxxxxxx

   The server:

   1. Checks that session_id exists
   2. Retrieves the Stripe Checkout Session
   3. Checks payment_status === "paid"
   4. Generates Cloudinary PDF URL
   5. Downloads PDF from Cloudinary
   6. Streams PDF to customer
   ============================================================ */

app.get(
  "/download",
  async (req, res) => {

    try {

      const sessionId = req.query.session_id;


      /* ------------------------------------------------------
         CHECK SESSION ID
         ------------------------------------------------------ */

      if (!sessionId) {

        return res.status(400).send(
          "Invalid download request."
        );
      }

      /* ------------------------------------------------------
         CLOUDINARY PUBLIC ID
         ------------------------------------------------------ */

      const publicId =
        process.env.CLOUDINARY_PDF_PUBLIC_ID;


      if (!publicId) {

        console.error(
          "CLOUDINARY_PDF_PUBLIC_ID is missing."
        );

        return res.status(500).send(
          "Download is not configured."
        );
      }


      /* ------------------------------------------------------
         GENERATE CLOUDINARY URL
         ------------------------------------------------------ */

          const pdfUrl = cloudinary.url(
    process.env.CLOUDINARY_PDF_PUBLIC_ID,
    {
        resource_type: "image",
        type: "upload",
        secure: true,
        format: "pdf"
    }
);


      console.log(
        "Downloading PDF for paid session:",
        sessionId
      );

console.log("Cloudinary PDF URL:", pdfUrl);


      /* ------------------------------------------------------
         FETCH PDF FROM CLOUDINARY
         ------------------------------------------------------ */

      const https =
        require("https");

      https.get(
        pdfUrl,
        (cloudinaryResponse) => {

          /* -----------------------------------------------
             CLOUDINARY ERROR
             ----------------------------------------------- */

          if (
            cloudinaryResponse.statusCode !== 200
          ) {

            console.error(
              "Cloudinary returned status:",
              cloudinaryResponse.statusCode
            );

            return res.status(502).send(
              "Unable to retrieve the eBook."
            );
          }


          /* -----------------------------------------------
             RESPONSE HEADERS
             ----------------------------------------------- */

          res.setHeader(
            "Content-Type",
            "application/pdf"
          );

          res.setHeader(
            "Content-Disposition",
            'attachment; filename="eBook_rqh3cz.pdf"'
          );

          res.setHeader(
            "Cache-Control",
            "no-store, no-cache, must-revalidate, private"
          );


          /* -----------------------------------------------
             STREAM PDF TO CUSTOMER
             ----------------------------------------------- */

          cloudinaryResponse.pipe(res);

        }
      ).on(
        "error",
        (error) => {

          console.error(
            "Cloudinary download error:",
            error.message
          );

          if (!res.headersSent) {

            res.status(500).send(
              "Unable to download the eBook."
            );
          }
        }
      );

    } catch (error) {

      console.error(
        "Download error:",
        error.message
      );

      if (!res.headersSent) {

        res.status(500).send(
          "Something went wrong while preparing your download."
        );
      }
    }
  }
);





const PORT = process.env.PORT || 3000;
const HOST = "0.0.0.0";
app.listen(PORT, HOST, () => {
    console.log(`Server listening on port ${PORT}`);
});
