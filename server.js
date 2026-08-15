require('dotenv').config();

const path = require('path');
const express = require('express');
const Stripe = require('stripe');
const https = require('https');
const cloudinary = require('cloudinary').v2;

// -----------------------------------------------------------------------------
// Validate required environment variables at startup
// -----------------------------------------------------------------------------
const requiredEnv = [
  'STRIPE_SECRET_KEY',
  'STRIPE_PRICE_ID',
  'STRIPE_WEBHOOK_SECRET',
  'CLOUDINARY_CLOUD_NAME',
  'CLOUDINARY_API_KEY',
  'CLOUDINARY_API_SECRET'
];

const missingEnv = requiredEnv.filter((name) => !process.env[name]);

if (missingEnv.length) {
  console.error(
    'Missing required environment variables:',
    missingEnv.join(', ')
  );
  process.exit(1);
}

const stripe = Stripe(process.env.STRIPE_SECRET_KEY);
const app = express();

// Render sits behind a proxy.
// This makes req.protocol correctly resolve to https.
app.set('trust proxy', 1);

cloudinary.config({
  cloud_name: process.env.CLOUDINARY_CLOUD_NAME,
  api_key: process.env.CLOUDINARY_API_KEY,
  api_secret: process.env.CLOUDINARY_API_SECRET
});

// -----------------------------------------------------------------------------
// Stripe webhook
// IMPORTANT: MUST be before express.json()
// -----------------------------------------------------------------------------
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
        process.env.STRIPE_WEBHOOK_SECRET
      );
    } catch (err) {
      console.error(
        'Webhook signature verification failed:',
        err.message
      );

      return res
        .status(400)
        .send(`Webhook Error: ${err.message}`);
    }

    if (event.type === 'checkout.session.completed') {
      const session = event.data.object;

      console.log(
        'Payment verified for session:',
        session.id
      );
    }

    res.json({
      received: true
    });
  }
);

// -----------------------------------------------------------------------------
// Normal JSON parser
// -----------------------------------------------------------------------------
app.use(express.json());

// -----------------------------------------------------------------------------
// Serve sales page, thank-you page, CSS, JS, etc.
// -----------------------------------------------------------------------------
app.use(
  express.static(
    path.join(__dirname, 'public')
  )
);

// -----------------------------------------------------------------------------
// Helper: determine public HTTPS URL
//
// PUBLIC_URL is optional.
// If omitted, Render's host is used automatically.
// -----------------------------------------------------------------------------
function getPublicBaseUrl(req) {

  const configuredUrl =
    (process.env.PUBLIC_URL || '').trim();

  if (configuredUrl) {

    const url =
      new URL(configuredUrl);

    if (
      url.protocol !== 'https:' &&
      url.protocol !== 'http:'
    ) {
      throw new Error(
        'PUBLIC_URL must start with http:// or https://'
      );
    }

    return url.origin;
  }

  const protocol =
    req.protocol;

  const host =
    req.get('host');

  if (!host) {
    throw new Error(
      'Could not determine the website host.'
    );
  }

  const url =
    new URL(`${protocol}://${host}`);

  return url.origin;
}

// -----------------------------------------------------------------------------
// Create Stripe Checkout Session
// -----------------------------------------------------------------------------
app.post(
  '/api/create-checkout-session',
  async (req, res) => {

    try {

      const baseUrl =
        getPublicBaseUrl(req);

      const successUrl =
        `${baseUrl}/thank-you-page.html?session_id={CHECKOUT_SESSION_ID}`;

      const cancelUrl =
        `${baseUrl}/`;

      // Validate URLs before sending them to Stripe.
      new URL(successUrl);
      new URL(cancelUrl);

      console.log(
        'Stripe success URL:',
        successUrl
      );

      console.log(
        'Stripe cancel URL:',
        cancelUrl
      );

      const session =
        await stripe.checkout.sessions.create({

          mode: 'payment',

          line_items: [
            {
              price:
                process.env.STRIPE_PRICE_ID,

              quantity: 1
            }
          ],

          success_url:
            successUrl,

          cancel_url:
            cancelUrl
        });

      res.json({
        url: session.url
      });

    } catch (err) {

      console.error(
        'Failed to create checkout session:',
        err.message
      );

      res.status(500).json({
        error:
          'Something went wrong while opening checkout. Please try again.'
      });
    }
  }
);

// -----------------------------------------------------------------------------
// Paid eBook download
//
// Stripe session is checked before the PDF is delivered.
// -----------------------------------------------------------------------------
app.get(
  '/download',
  async (req, res) => {

    try {

      const sessionId =
        req.query.session_id;

      if (!sessionId) {

        return res
          .status(400)
          .send(
            'Invalid download request.'
          );
      }

      // Retrieve the Stripe Checkout Session
      const session =
        await stripe.checkout.sessions.retrieve(
          sessionId
        );

      // Verify payment
      if (
        session.payment_status !== 'paid'
      ) {

        console.warn(
          'Unpaid download attempt:',
          sessionId
        );

        return res
          .status(403)
          .send(
            'Payment has not been completed.'
          );
      }

      console.log(
        'Downloading PDF for paid session:',
        sessionId
      );

      // Cloudinary PDF public ID
      const publicId =
        process.env.CLOUDINARY_PDF_PUBLIC_ID ||
        'eBook_rqh3cz';

      // Generate Cloudinary PDF URL
      const pdfUrl =
        cloudinary.url(
          publicId,
          {
            resource_type: 'image',
            type: 'upload',
            secure: true
          }
        );

      console.log(
        'Cloudinary PDF URL:',
        pdfUrl
      );

      // Retrieve PDF from Cloudinary
      https.get(
        pdfUrl,
        (cloudinaryResponse) => {

          console.log(
            'Cloudinary returned status:',
            cloudinaryResponse.statusCode
          );

          // Cloudinary did not return the PDF
          if (
            cloudinaryResponse.statusCode !== 200
          ) {

            let body = '';

            cloudinaryResponse.on(
              'data',
              (chunk) => {
                body += chunk.toString();
              }
            );

            cloudinaryResponse.on(
              'end',
              () => {

                console.error(
                  'Cloudinary response:',
                  body.slice(0, 1000)
                );

                if (!res.headersSent) {

                  res
                    .status(502)
                    .send(
                      'Unable to retrieve the eBook from Cloudinary.'
                    );
                }
              }
            );

            return;
          }

          // Tell browser this is a PDF
          res.setHeader(
            'Content-Type',
            'application/pdf'
          );

          // Force download
          res.setHeader(
            'Content-Disposition',
            'attachment; filename="The-AI-Content-Creators-Playbook.pdf"'
          );

          // Prevent caching
          res.setHeader(
            'Cache-Control',
            'no-store, no-cache, must-revalidate, private'
          );

          // Stream Cloudinary PDF to customer
          cloudinaryResponse.pipe(res);
        }
      ).on(
        'error',
        (err) => {

          console.error(
            'Cloudinary connection error:',
            err.message
          );

          if (!res.headersSent) {

            res
              .status(500)
              .send(
                'Unable to download the eBook.'
              );
          }
        }
      );

    } catch (err) {

      console.error(
        'Download error:',
        err.message
      );

      if (!res.headersSent) {

        res
          .status(500)
          .send(
            'Something went wrong while preparing your download.'
          );
      }
    }
  }
);

// -----------------------------------------------------------------------------
// Health check
// -----------------------------------------------------------------------------
app.get(
  '/health',
  (req, res) => {

    res.json({
      status: 'ok'
    });

  }
);

// -----------------------------------------------------------------------------
// Render configuration
//
// Render requires the server to listen on 0.0.0.0
// and use the assigned PORT.
// -----------------------------------------------------------------------------
const PORT =
  process.env.PORT || 10000;

const HOST =
  '0.0.0.0';

app.listen(
  PORT,
  HOST,
  () => {

    console.log(
      `Server listening on ${HOST}:${PORT}`
    );

  }
);