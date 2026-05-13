import nodemailer from "nodemailer";
import { env } from "../config/env.js";

interface EmailOptions {
  to: string;
  subject: string;
  html: string;
}

async function sendEmailWithResend({
  to,
  subject,
  html,
}: EmailOptions): Promise<boolean> {
  if (!env.RESEND_API_KEY) {
    return false;
  }

  try {
    const response = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${env.RESEND_API_KEY}`,
      },
      body: JSON.stringify({
        from: env.RESEND_FROM_EMAIL || "noreply@reviewdesk.ai",
        to,
        subject,
        html,
      }),
    });

    if (!response.ok) {
      const error = await response.text();
      console.warn("Resend API failed:", error);
      return false;
    }

    console.log("Email sent successfully via Resend");
    return true;
  } catch (error) {
    console.warn("Resend email failed, will try nodemailer:", error);
    return false;
  }
}

async function sendEmailWithNodemailer({
  to,
  subject,
  html,
}: EmailOptions): Promise<boolean> {
  if (!env.SMTP_HOST || !env.SMTP_USER || !env.SMTP_PASSWORD) {
    console.warn("Nodemailer SMTP credentials not configured");
    return false;
  }

  try {
    const transporter = nodemailer.createTransport({
      host: env.SMTP_HOST,
      port: env.SMTP_PORT || 587,
      secure: (env.SMTP_PORT || 587) === 465, // true for 465, false for other ports
      auth: {
        user: env.SMTP_USER,
        pass: env.SMTP_PASSWORD,
      },
    });

    await transporter.sendMail({
      from: env.SMTP_FROM_EMAIL || "noreply@reviewdesk.ai",
      to,
      subject,
      html,
    });

    console.log("Email sent successfully via Nodemailer");
    return true;
  } catch (error) {
    console.error("Nodemailer email failed:", error);
    return false;
  }
}

async function sendEmail({ to, subject, html }: EmailOptions) {
  console.log(`Attempting to send email to ${to}`);

  // Try Resend first
  const resendSuccess = await sendEmailWithResend({ to, subject, html });
  if (resendSuccess) {
    return;
  }

  // Fallback to Nodemailer
  const nodemailerSuccess = await sendEmailWithNodemailer({
    to,
    subject,
    html,
  });
  if (nodemailerSuccess) {
    return;
  }

  // Both failed
  throw new Error("Failed to send email via both Resend and Nodemailer");
}

function createPasswordResetEmailHtml(
  resetUrl: string,
  userName: string,
): string {
  return `
    <!DOCTYPE html>
    <html>
      <head>
        <meta charset="UTF-8">
        <meta name="viewport" content="width=device-width, initial-scale=1.0">
        <style>
          body {
            font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', 'Roboto', 'Helvetica', 'Arial', sans-serif;
            line-height: 1.6;
            color: #333;
          }
          .container {
            max-width: 600px;
            margin: 0 auto;
            padding: 20px;
            background-color: #f9fafb;
          }
          .email-body {
            background-color: white;
            padding: 30px;
            border-radius: 8px;
            box-shadow: 0 1px 3px rgba(0, 0, 0, 0.1);
          }
          .logo {
            font-size: 24px;
            font-weight: bold;
            color: #000;
            margin-bottom: 20px;
          }
          .greeting {
            font-size: 16px;
            margin-bottom: 15px;
          }
          .content {
            font-size: 14px;
            margin-bottom: 25px;
            color: #555;
          }
          .cta-button {
            display: inline-block;
            background-color: #000;
            color: white;
            padding: 12px 30px;
            text-decoration: none;
            border-radius: 6px;
            margin: 20px 0;
            font-weight: 600;
          }
          .cta-button:hover {
            background-color: #222;
          }
          .copy-link {
            background-color: #f3f4f6;
            padding: 12px;
            border-radius: 4px;
            word-break: break-all;
            font-size: 12px;
            color: #666;
            margin: 15px 0;
          }
          .footer {
            font-size: 12px;
            color: #999;
            margin-top: 25px;
            border-top: 1px solid #e5e7eb;
            padding-top: 15px;
          }
          .warning {
            background-color: #fef3c7;
            padding: 12px;
            border-radius: 4px;
            font-size: 12px;
            color: #92400e;
            margin: 15px 0;
          }
        </style>
      </head>
      <body>
        <div class="container">
          <div class="email-body">
            <div class="logo">ReviewDesk</div>
            <div class="greeting">Hi ${userName},</div>
            <div class="content">
              We received a request to reset your password. If you made this request, click the button below to reset your password.
            </div>
            <a href="${resetUrl}" class="cta-button">Reset Password</a>
            <div class="content">
              Or copy and paste this link in your browser:
            </div>
            <div class="copy-link">${resetUrl}</div>
            <div class="warning">
              This link will expire in 60 minutes.
            </div>
            <div class="content">
              If you didn't request this, please ignore this email or let us know if you have concerns.
            </div>
            <div class="footer">
              <p>© 2026 ReviewDesk. All rights reserved.</p>
              <p>This is an automated message, please do not reply to this email.</p>
            </div>
          </div>
        </div>
      </body>
    </html>
  `;
}

function createEmailVerificationEmailHtml(
  verificationUrl: string,
  userName: string,
): string {
  return `
    <!DOCTYPE html>
    <html>
      <head>
        <meta charset="UTF-8">
        <meta name="viewport" content="width=device-width, initial-scale=1.0">
        <style>
          body {
            font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', 'Roboto', 'Helvetica', 'Arial', sans-serif;
            line-height: 1.6;
            color: #333;
          }
          .container {
            max-width: 600px;
            margin: 0 auto;
            padding: 20px;
            background-color: #f9fafb;
          }
          .email-body {
            background-color: white;
            padding: 30px;
            border-radius: 8px;
            box-shadow: 0 1px 3px rgba(0, 0, 0, 0.1);
          }
          .logo {
            font-size: 24px;
            font-weight: bold;
            color: #000;
            margin-bottom: 20px;
          }
          .greeting {
            font-size: 16px;
            margin-bottom: 15px;
          }
          .content {
            font-size: 14px;
            margin-bottom: 25px;
            color: #555;
          }
          .cta-button {
            display: inline-block;
            background-color: #000;
            color: white;
            padding: 12px 30px;
            text-decoration: none;
            border-radius: 6px;
            margin: 20px 0;
            font-weight: 600;
          }
          .cta-button:hover {
            background-color: #222;
          }
          .copy-link {
            background-color: #f3f4f6;
            padding: 12px;
            border-radius: 4px;
            word-break: break-all;
            font-size: 12px;
            color: #666;
            margin: 15px 0;
          }
          .footer {
            font-size: 12px;
            color: #999;
            margin-top: 25px;
            border-top: 1px solid #e5e7eb;
            padding-top: 15px;
          }
          .info {
            background-color: #dbeafe;
            padding: 12px;
            border-radius: 4px;
            font-size: 12px;
            color: #0c4a6e;
            margin: 15px 0;
          }
        </style>
      </head>
      <body>
        <div class="container">
          <div class="email-body">
            <div class="logo">ReviewDesk</div>
            <div class="greeting">Hi ${userName},</div>
            <div class="content">
              Welcome to ReviewDesk! Please verify your email address to complete your registration and start managing your reviews.
            </div>
            <a href="${verificationUrl}" class="cta-button">Verify Email</a>
            <div class="content">
              Or copy and paste this link in your browser:
            </div>
            <div class="copy-link">${verificationUrl}</div>
            <div class="info">
              This link will expire in 24 hours.
            </div>
            <div class="content">
              If you didn't create this account, please disregard this email.
            </div>
            <div class="footer">
              <p>© 2026 ReviewDesk. All rights reserved.</p>
              <p>This is an automated message, please do not reply to this email.</p>
            </div>
          </div>
        </div>
      </body>
    </html>
  `;
}

export {
  sendEmail,
  createPasswordResetEmailHtml,
  createEmailVerificationEmailHtml,
};
