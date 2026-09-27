const express = require("express");
const cors = require("cors");
const nodemailer = require("nodemailer");

const app = express();

// ---------------------------------------------------------------------------
// MIDDLEWARES
// ---------------------------------------------------------------------------
app.use(cors());
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// ---------------------------------------------------------------------------
// EMAIL CONFIG (GMAIL + APP PASSWORD)
// ---------------------------------------------------------------------------
const SYSTEM_EMAIL = "pneumoniauser@gmail.com"; // system email (also used as sender)

//  For FYP/testing only. In production, move this to env variables.
const transporter = nodemailer.createTransport({
  service: "gmail",
  auth: {
    user: SYSTEM_EMAIL,
    pass: "uavh sqoi zigj rlwv", // 16-character app password (without spaces)
  },
});

// Small helper to check transporter
transporter.verify((err, success) => {
  if (err) {
    console.error(" Error configuring mail transporter:", err);
  } else {
    console.log(" Mail transporter ready.");
  }
});

// ---------------------------------------------------------------------------
// HELPER: Wrap HTML email
// ---------------------------------------------------------------------------
function wrapHtml(title, innerHtml) {
  return `
    <div style="font-family: Arial, sans-serif; color:#333; padding:16px;">
      <h2 style="color:#0E4E90; margin-bottom:8px;">${title}</h2>
      <div style="font-size:14px; line-height:1.6;">
        ${innerHtml}
      </div>
      <hr style="margin:20px 0; border:none; border-top:1px solid #ddd;">
      <p style="font-size:12px; color:#777;">
        This is an automated message from <strong>PneumoScan AI</strong>. Please do not reply directly to this email.
      </p>
    </div>
  `;
}

// HELPER: safe sender
async function sendMail({ to, subject, html }) {
  if (!to) {
    console.warn("⚠ Email not sent – 'to' is empty. Subject:", subject);
    return;
  }
  try {
    await transporter.sendMail({
      from: `"PneumoScan AI" <${SYSTEM_EMAIL}>`,
      to,
      subject,
      html,
    });
    console.log(` Email sent → ${to} [${subject}]`);
  } catch (err) {
    console.error(" Error sending email:", err);
  }
}

// ---------------------------------------------------------------------------
// EMAIL TEMPLATES
// ---------------------------------------------------------------------------

// ADMIN: signup (to admin)
function adminSignupEmail(name) {
  const safeName = name || "User";
  return wrapHtml(
    "Admin sign-up received — PneumoScan AI",
    `
      <p>Dear ${safeName},</p>
      <p>
        Thank you for registering as an <strong>Admin</strong> in
        <strong>PneumoScan AI</strong>.
      </p>
      <p>
        Your admin account request has been received and is currently
        <strong>pending approval</strong>. Once your request is approved,
        you will be able to access the Admin Dashboard and manage radiologists.
      </p>
      <p>Best regards,<br>PneumoScan AI Team</p>
    `
  );
}

// ADMIN: signup notification to system email
function adminRequestToSystemEmail(payload) {
  const { name, email, phone, institution } = payload;
  return wrapHtml(
    "New admin sign-up request — PneumoScan AI",
    `
      <p>Hello,</p>
      <p>A new user has requested <strong>Admin</strong> access in the system.</p>
      <p><strong>Details:</strong></p>
      <ul>
        <li><strong>Name:</strong> ${name || "N/A"}</li>
        <li><strong>Email:</strong> ${email || "N/A"}</li>
        ${phone ? `<li><strong>Phone:</strong> ${phone}</li>` : ""}
        ${institution ? `<li><strong>Institution:</strong> ${institution}</li>` : ""}
      </ul>
      <p>
        Please log in to Firebase / Admin Management to
        <strong>approve or reject</strong> this admin.
      </p>
      <p>Best regards,<br>PneumoScan AI System</p>
    `
  );
}

// ADMIN: approved
function adminApprovedEmail(name) {
  const safeName = name || "Admin";
  return wrapHtml(
    "Admin account approved — PneumoScan AI",
    `
      <p>Dear ${safeName},</p>
      <p>
        Your request for <strong>Admin</strong> access in
        <strong>PneumoScan AI</strong> has been <strong>approved</strong>.
      </p>
      <p>
        You can now log in to the Admin Dashboard and manage radiologist accounts,
        review activity, and oversee system usage.
      </p>
      <p>Best regards,<br>PneumoScan AI Team</p>
    `
  );
}

// ADMIN: rejected
function adminRejectedEmail(name) {
  const safeName = name || "Applicant";
  return wrapHtml(
    "Admin application outcome — PneumoScan AI",
    `
      <p>Dear ${safeName},</p>
      <p>
        Thank you for your interest in becoming an Admin on
        <strong>PneumoScan AI</strong>.
      </p>
      <p>
        After review, we are unable to approve your admin account at this time.
        This may be due to eligibility criteria or internal requirements.
      </p>
      <p>
        If you believe this is an error, please contact the system owner or
        your institution for further clarification.
      </p>
      <p>Best regards,<br>PneumoScan AI Team</p>
    `
  );
}

// RADIOLOGIST: signup (to radiologist)
function radiologistSignupEmail(name) {
  const safeName = name || "Doctor";
  return wrapHtml(
    "Sign-up received — PneumoScan AI",
    `
      <p>Dear ${safeName},</p>
      <p>
        Thank you for signing up as a <strong>Radiologist</strong> in
        <strong>PneumoScan AI</strong>.
      </p>
      <p>
        Your account has been created successfully and is currently
        <strong>pending admin approval</strong>.
      </p>
      <p>
        Once an Admin reviews your profile, you will receive another email
        confirming whether your account has been approved or rejected.
      </p>
      <p>Best regards,<br>PneumoScan AI Team</p>
    `
  );
}

// RADIOLOGIST: signup notification to admins
function radiologistRequestToAdmins(payload) {
  const { name, email, specialization, institution } = payload;
  return wrapHtml(
    "New radiologist application — PneumoScan AI",
    `
      <p>Dear Admin,</p>
      <p>
        A new <strong>Radiologist</strong> has registered in
        <strong>PneumoScan AI</strong> and is waiting for your review.
      </p>
      <p><strong>Applicant Details:</strong></p>
      <ul>
        <li><strong>Name:</strong> ${name || "N/A"}</li>
        <li><strong>Email:</strong> ${email || "N/A"}</li>
        ${specialization ? `<li><strong>Specialization:</strong> ${specialization}</li>` : ""}
        ${institution ? `<li><strong>Institution:</strong> ${institution}</li>` : ""}
      </ul>
      <p>
        Please log in to the <strong>Admin Dashboard</strong> to
        approve or reject this application.
      </p>
      <p>Best regards,<br>PneumoScan AI System</p>
    `
  );
}

// RADIOLOGIST: approved
function radiologistApprovedEmail(name) {
  const safeName = name || "Doctor";
  return wrapHtml(
    "Account approved — PneumoScan AI",
    `
      <p>Dear ${safeName},</p>
      <p>
        We are pleased to inform you that your
        <strong>PneumoScan AI</strong> radiologist account has been
        <strong>approved</strong>.
      </p>
      <p>
        You can now log in, upload chest X-rays, review AI-assisted analysis,
        and generate diagnostic reports.
      </p>
      <p>Best regards,<br>PneumoScan AI Team</p>
    `
  );
}

// RADIOLOGIST: rejected
function radiologistRejectedEmail(name) {
  const safeName = name || "Applicant";
  return wrapHtml(
    "Application outcome — PneumoScan AI",
    `
      <p>Dear ${safeName},</p>
      <p>
        Thank you for your interest in using <strong>PneumoScan AI</strong>.
      </p>
      <p>
        After reviewing your details, we are unable to approve your radiologist
        account at this time. This may be due to eligibility criteria or
        incomplete / insufficient information.
      </p>
      <p>
        If you believe this is an error, please contact the system administrator
        through your institution.
      </p>
      <p>Best regards,<br>PneumoScan AI Team</p>
    `
  );
}

// RADIOLOGIST: account deleted
function radiologistDeletedEmail(name) {
  const safeName = name || "Doctor";
  return wrapHtml(
    "Account deleted — PneumoScan AI",
    `
      <p>Dear ${safeName},</p>
      <p>
        This is to confirm that your <strong>PneumoScan AI</strong> account
        has been <strong>deleted</strong> at your request.
      </p>
      <p>
        All associated reports stored under your account in the system have
        also been removed as part of this process.
      </p>
      <p>
        If this deletion was not initiated by you, please contact the system
        administrator immediately.
      </p>
      <p>Best regards,<br>PneumoScan AI Team</p>
    `
  );
}

// RADIOLOGIST: account deleted → notify admins
function radiologistDeletedNotifyAdmins(payload) {
  const { name, email } = payload;
  return wrapHtml(
    "Radiologist account removed — PneumoScan AI",
    `
      <p>Dear Admin,</p>
      <p>
        A radiologist account has been <strong>deleted</strong> from the
        <strong>PneumoScan AI</strong> system.
      </p>
      <p><strong>Radiologist Details:</strong></p>
      <ul>
        <li><strong>Name:</strong> ${name || "N/A"}</li>
        <li><strong>Email:</strong> ${email || "N/A"}</li>
      </ul>
      <p>
        All reports linked to this radiologist have also been removed according
        to the account deletion process.
      </p>
      <p>Best regards,<br>PneumoScan AI System</p>
    `
  );
}

// RADIOLOGIST: account deactivated (by admin)
function radiologistDeactivatedEmail(name) {
  const safeName = name || "Doctor";
  return wrapHtml(
    "Account deactivated — PneumoScan AI",
    `
      <p>Dear ${safeName},</p>
      <p>
        Your <strong>PneumoScan AI</strong> radiologist account has been
        <strong>deactivated</strong> by an administrator.
      </p>
      <p>
        You will no longer be able to log in or use the Dashboard for
        uploading X-rays or generating reports.
      </p>
      <p>
        If you believe this action is a mistake, please contact the system
        administrator or your institution for assistance.
      </p>
      <p>Best regards,<br>PneumoScan AI Team</p>
    `
  );
}

// ---------------------------------------------------------------------------
// ROUTES
// ---------------------------------------------------------------------------

// Health check
app.get("/", (req, res) => {
  res.send("PneumoScan AI email server is running ");
});

// Simple test email (send to system email itself)
app.get("/send-test", async (req, res) => {
  try {
    console.log("  GET /send-test");
    await sendMail({
      to: SYSTEM_EMAIL,
      subject: "Test email from PneumoScan AI email server",
      html: wrapHtml(
        "Test email",
        "<p>If you are seeing this, the Node.js email server is working correctly.</p>"
      ),
    });
    res.send("Test email sent ");
  } catch (err) {
    console.error("Error in /send-test:", err);
    res.status(500).send("Failed to send test email ");
  }
});

// ---------------------------------------------------------------------------
// 1) ADMIN EMAIL ROUTES
// ---------------------------------------------------------------------------

// Admin signup: email to admin + email to system email
// Body: { adminEmail, adminName, adminPhone?, adminInstitution? }
app.post("/email/admin-signup", async (req, res) => {
  try {
    const { adminEmail, adminName, adminPhone, adminInstitution } = req.body;

    console.log("  POST /email/admin-signup", {
      adminEmail,
      adminName,
      adminPhone,
      adminInstitution,
    });

    if (!adminEmail) {
      return res
        .status(400)
        .json({ success: false, error: "adminEmail is required" });
    }

    // Email to admin (signup received, pending approval)
    await sendMail({
      to: adminEmail,
      subject: "PneumoScan AI — Admin sign-up received",
      html: adminSignupEmail(adminName),
    });

    // Email to system email (new admin request)
    await sendMail({
      to: SYSTEM_EMAIL,
      subject: "PneumoScan AI — New admin sign-up request",
      html: adminRequestToSystemEmail({
        name: adminName,
        email: adminEmail,
        phone: adminPhone,
        institution: adminInstitution,
      }),
    });

    res.json({ success: true });
  } catch (err) {
    console.error("Error in /email/admin-signup:", err);
    res
      .status(500)
      .json({ success: false, error: "Failed to send admin signup emails" });
  }
});

// Admin status update: approved / rejected
// Body: { adminEmail, adminName, status: "approved" | "rejected" }
app.post("/email/admin-status", async (req, res) => {
  try {
    const { adminEmail, adminName, status } = req.body;

    console.log("  POST /email/admin-status", {
      adminEmail,
      adminName,
      status,
    });

    if (!adminEmail || !status) {
      return res.status(400).json({
        success: false,
        error: "adminEmail and status are required",
      });
    }

    let subject, html;
    if (status === "approved") {
      subject = "PneumoScan AI — Admin account approved";
      html = adminApprovedEmail(adminName);
    } else if (status === "rejected") {
      subject = "PneumoScan AI — Admin application outcome";
      html = adminRejectedEmail(adminName);
    } else {
      return res.status(400).json({
        success: false,
        error: "status must be 'approved' or 'rejected'",
      });
    }

    await sendMail({ to: adminEmail, subject, html });
    res.json({ success: true });
  } catch (err) {
    console.error("Error in /email/admin-status:", err);
    res
      .status(500)
      .json({ success: false, error: "Failed to send admin status email" });
  }
});

// ---------------------------------------------------------------------------
// 2) RADIOLOGIST EMAIL ROUTES
// ---------------------------------------------------------------------------

// Radiologist signup: email to radiologist + notify all approved admins
// Body: { radiologistEmail, radiologistName, specialization?, institution?, adminEmails?: [] }
app.post("/email/radiologist-signup", async (req, res) => {
  try {
    const {
      radiologistEmail,
      radiologistName,
      specialization,
      institution,
      adminEmails,
    } = req.body;

    console.log("  POST /email/radiologist-signup", {
      radiologistEmail,
      radiologistName,
      specialization,
      institution,
      adminEmailsCount: Array.isArray(adminEmails) ? adminEmails.length : 0,
    });

    if (!radiologistEmail) {
      return res.status(400).json({
        success: false,
        error: "radiologistEmail is required",
      });
    }

    // Email to radiologist
    await sendMail({
      to: radiologistEmail,
      subject: "PneumoScan AI — Radiologist sign-up received",
      html: radiologistSignupEmail(radiologistName),
    });

    // Notify all approved admins (if any provided)
    if (Array.isArray(adminEmails) && adminEmails.length > 0) {
      const html = radiologistRequestToAdmins({
        name: radiologistName,
        email: radiologistEmail,
        specialization,
        institution,
      });

      await Promise.all(
        adminEmails
          .filter((e) => !!e)
          .map((adminEmail) =>
            sendMail({
              to: adminEmail,
              subject: "PneumoScan AI — New radiologist application",
              html,
            })
          )
      );
    }

    res.json({ success: true });
  } catch (err) {
    console.error("Error in /email/radiologist-signup:", err);
    res.status(500).json({
      success: false,
      error: "Failed to send radiologist signup emails",
    });
  }
});

// Radiologist status update: approved / rejected
// Body: { radiologistEmail, radiologistName, status: "approved" | "rejected" }
app.post("/email/radiologist-status", async (req, res) => {
  try {
    const { radiologistEmail, radiologistName, status } = req.body;

    console.log("  POST /email/radiologist-status", {
      radiologistEmail,
      radiologistName,
      status,
    });

    if (!radiologistEmail || !status) {
      return res.status(400).json({
        success: false,
        error: "radiologistEmail and status are required",
      });
    }

    let subject, html;
    if (status === "approved") {
      subject = "PneumoScan AI — Account approved";
      html = radiologistApprovedEmail(radiologistName);
    } else if (status === "rejected") {
      subject = "PneumoScan AI — Application outcome";
      html = radiologistRejectedEmail(radiologistName);
    } else {
      return res.status(400).json({
        success: false,
        error: "status must be 'approved' or 'rejected'",
      });
    }

    await sendMail({ to: radiologistEmail, subject, html });
    res.json({ success: true });
  } catch (err) {
    console.error("Error in /email/radiologist-status:", err);
    res.status(500).json({
      success: false,
      error: "Failed to send radiologist status email",
    });
  }
});

// Radiologist deleted their account
// Body: { radiologistEmail, radiologistName, adminEmails?: [] }
app.post("/email/radiologist-deleted", async (req, res) => {
  try {
    const { radiologistEmail, radiologistName, adminEmails } = req.body;

    console.log("  POST /email/radiologist-deleted", {
      radiologistEmail,
      radiologistName,
      adminEmailsCount: Array.isArray(adminEmails) ? adminEmails.length : 0,
    });

    if (!radiologistEmail) {
      return res.status(400).json({
        success: false,
        error: "radiologistEmail is required",
      });
    }

    // Email to radiologist
    await sendMail({
      to: radiologistEmail,
      subject: "PneumoScan AI — Account deleted",
      html: radiologistDeletedEmail(radiologistName),
    });

    // Notify admins (if provided)
    if (Array.isArray(adminEmails) && adminEmails.length > 0) {
      const html = radiologistDeletedNotifyAdmins({
        name: radiologistName,
        email: radiologistEmail,
      });

      await Promise.all(
        adminEmails
          .filter((e) => !!e)
          .map((adminEmail) =>
            sendMail({
              to: adminEmail,
              subject: "PneumoScan AI — Radiologist account removed",
              html,
            })
          )
      );
    }

    res.json({ success: true });
  } catch (err) {
    console.error("Error in /email/radiologist-deleted:", err);
    res.status(500).json({
      success: false,
      error: "Failed to send radiologist deletion emails",
    });
  }
});

// Radiologist deactivated by admin
// Body: { radiologistEmail, radiologistName }
app.post("/email/radiologist-deactivated", async (req, res) => {
  try {
    const { radiologistEmail, radiologistName } = req.body;

    console.log("  POST /email/radiologist-deactivated", {
      radiologistEmail,
      radiologistName,
    });

    if (!radiologistEmail) {
      return res.status(400).json({
        success: false,
        error: "radiologistEmail is required",
      });
    }

    await sendMail({
      to: radiologistEmail,
      subject: "PneumoScan AI — Account deactivated",
      html: radiologistDeactivatedEmail(radiologistName),
    });

    res.json({ success: true });
  } catch (err) {
    console.error("Error in /email/radiologist-deactivated:", err);
    res.status(500).json({
      success: false,
      error: "Failed to send deactivation email",
    });
  }
});

// ---------------------------------------------------------------------------
// OPTIONAL: Legacy simple signup endpoint (backward compatibility)
// Body: { to, name, role }
// ---------------------------------------------------------------------------
app.post("/send-signup-email", async (req, res) => {
  try {
    const { to, name, role } = req.body;

    console.log("  POST /send-signup-email", { to, name, role });

    if (!to) {
      return res.status(400).json({
        success: false,
        error: "to is required",
      });
    }

    const safeRole = (role || "").toLowerCase();
    let html;

    if (safeRole === "admin") {
      html = adminSignupEmail(name);
    } else {
      html = radiologistSignupEmail(name);
    }

    await sendMail({
      to,
      subject: "PneumoScan AI — Sign-up received",
      html,
    });

    res.json({ success: true });
  } catch (err) {
    console.error("Error in /send-signup-email:", err);
    res.status(500).json({
      success: false,
      error: "Failed to send signup email",
    });
  }
});

// ---------------------------------------------------------------------------
// START SERVER
// ---------------------------------------------------------------------------
const PORT = 4000;
app.listen(PORT, () => {
  console.log(` Email server running on http://localhost:${PORT}`);
});
