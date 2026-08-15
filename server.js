require('dotenv').config();

const path = require('path');
const express = require('express');
const Stripe = require('stripe');

// -----------------------------------------------------------------------------
// Validate required environment variables at startup
// -----------------------------------------------------------------------------

const requiredEnv = [
  'STRIPE_SECRET_KEY',
  'STRIPE_PRICE_ID',
  'STRIPE_WEBHOOK_SECRET'
];

const missingEnv = requiredEnv.filter(
  (name) => !process.env[name]
);

if (missingEnv.length) {
  console.error(
    'Missing required environment variables:',
    missingEnv.join(', ')
  );

  process.exit(1);
}

const stripe = Stripe(
  process.env.STRIPE_SECRET_KEY
);

const app = express();

// Render sits behind a proxy.
// This allows req.protocol to correctly detect HTTPS.
app.set('trust proxy', 1);

// -----------------------------------------------------------------------------
// Stripe Webhook
// IMPORTANT: This MUST be before express.json()
// -----------------------------------------------------------------------------

app.post(
  '/api/stripe-webhook',
  express.raw({
    type: 'application/json'
  }),
  (req, res) => {

    const signature =
      req.headers['stripe-signature'];

    let event;

    try {

      event =
        stripe.webhooks.constructEvent(
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
        .send(
          `Webhook Error: ${err.message}`
        );
    }

    if (
      event.type ===
      'checkout.session.completed'
    ) {

      const session =
        event.data.object;

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

app.use(
  express.json()
);

// -----------------------------------------------------------------------------
// Serve website files
// -----------------------------------------------------------------------------

app.use(
  express.static(
    path.join(
      __dirname,
      'public'
    )
  )
);

// -----------------------------------------------------------------------------
// Determine public HTTPS URL
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
    new URL(
      `${protocol}://${host}`
    );

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
// Paid eBook Download
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

      console.log(
        'Checking Stripe session:',
        sessionId
      );

      // -----------------------------------------------------------------------
      // Verify Stripe Checkout Session
      // -----------------------------------------------------------------------

      const session =
        await stripe.checkout.sessions.retrieve(
          sessionId
        );

      console.log(
        'Stripe payment status:',
        session.payment_status
      );

      // -----------------------------------------------------------------------
      // Only paid customers can download
      // -----------------------------------------------------------------------

      if (
        session.payment_status !== 'paid'
      ) {

        console.warn(
          'Download rejected - payment not completed:',
          sessionId
        );

        return res
          .status(403)
          .send(
            'Payment has not been completed.'
          );
      }

      // -----------------------------------------------------------------------
      // Protected PDF location
      //
      // IMPORTANT:
      // The PDF must NOT be inside public/
      //
      // Correct structure:
      //
      // project/
      // ├── server.js
      // ├── private/
      // │   └── eBook_rqh3cz.pdf
      // └── public/
      //     ├── index.html
      //     └── thank-you-page.html
      // -----------------------------------------------------------------------

      const pdfPath =
        path.join(
          __dirname,
          'private',
          'eBook_rqh3cz.pdf'
        );

      console.log(
        'Sending paid eBook:',
        pdfPath
      );

      // -----------------------------------------------------------------------
      // Send PDF to customer
      // -----------------------------------------------------------------------

      return res.download(
        pdfPath,
        'eBook_rqh3cz.pdf',
        (err) => {

          if (err) {

            console.error(
              'PDF download error:',
              err.message
            );

            if (!res.headersSent) {

              return res
                .status(500)
                .send(
                  'Unable to download the eBook.'
                );
            }
          }
        }
      );

    } catch (error) {

      console.error(
        'Download error:',
        error.message
      );

      if (!res.headersSent) {

        return res
          .status(500)
          .send(
            'Something went wrong while preparing the download.'
          );
      }
    }
  }
);

// -----------------------------------------------------------------------------
// Health Check
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
// Render requires:
// - 0.0.0.0
// - process.env.PORT
// -----------------------------------------------------------------------------

const PORT =
  process.env.PORT || 10000;

const HOST =
  '0.0.0.0';

// -----------------------------------------------------------------------------
// Check that the protected eBook exists
// -----------------------------------------------------------------------------

const fs =
  require('fs');

const ebookPath =
  path.join(
    __dirname,
    'private',
    'eBook_rqh3cz.pdf'
  );

if (
  !fs.existsSync(ebookPath)
) {

  console.warn(
    'WARNING: eBook PDF not found at:',
    ebookPath
  );

  console.warn(
    'Create private/eBook_rqh3cz.pdf before testing downloads.'
  );

} else {

  console.log(
    'Protected eBook found:',
    ebookPath
  );
}

// -----------------------------------------------------------------------------
// Start Server
// -----------------------------------------------------------------------------

app.listen(
  PORT,
  HOST,
  () => {

    console.log(
      `Server listening on ${HOST}:${PORT}`
    );

  }
);