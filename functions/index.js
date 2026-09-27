const functions = require("firebase-functions");
const admin = require("firebase-admin");
const nodemailer = require("nodemailer");
const cors = require("cors")({ origin: true });

admin.initializeApp();

// Configure nodemailer for sending emails
const transporter = nodemailer.createTransport({
  service: "gmail",
  auth: {
    user: "ahsaanali12live@gmail.com", // REPLACE WITH functions.config().gmail.email IN PRODUCTION
    pass: "unqo zmee qshq yptd", // REPLACE WITH functions.config().gmail.password IN PRODUCTION
  },
});

// Function to send approval request to admin
exports.sendApprovalRequest = functions.https.onCall(async (data, context) => {
  const { userId, userEmail, userName, licenseNumber, hospital } = data;

  const mailOptions = {
    from: "PneumoScan AI <ahsaanali12live@gmail.com>",
    to: "ahsaanali12live@gmail.com", // REPLACE WITH functions.config().admin.email IN PRODUCTION
    subject: `New Radiologist Approval Request - ${userName}`,
    html: `
      <h2>New Radiologist Registration</h2>
      <p><strong>Name:</strong> ${userName}</p>
      <p><strong>Email:</strong> ${userEmail}</p>
      <p><strong>PMDC License:</strong> ${licenseNumber}</p>
      <p><strong>Hospital:</strong> ${hospital}</p>
      <p><strong>Request Date:</strong> ${new Date().toLocaleString()}</p>
      
      <h3>Approve or Reject this application:</h3>
      <p>
        <a href="apppneumonia.web.app/approve?userId=${userId}&action=approve" 
           style="background-color: #4CAF50; color: white; padding: 10px 20px; text-decoration: none; border-radius: 4px;">
          Approve
        </a>
        <a href="apppneumonia.web.app/approve?userId=${userId}&action=reject" 
           style="background-color: #f44336; color: white; padding: 10px 20px; text-decoration: none; border-radius: 4px; margin-left: 10px;">
          Reject
        </a>
      </p>
    `,
  };

  try {
    await transporter.sendMail(mailOptions);
    return { success: true };
  } catch (error) {
    console.error("Error sending email:", error);
    throw new functions.https.HttpsError(
      "internal",
      "Error sending approval request"
    );
  }
});

// HTTP endpoint for admin approval/rejection
exports.processApproval = functions.https.onRequest(async (req, res) => {
  return cors(req, res, async () => {
    const { userId, action } = req.query;

    if (!userId || !action) {
      return res.status(400).send("Missing parameters");
    }

    try {
      const userDoc = await admin
        .firestore()
        .collection("radiologists")
        .doc(userId)
        .get();

      if (!userDoc.exists) {
        return res.status(404).send("User not found");
      }

      if (action === "approve") {
        // Update user as approved
        await admin.firestore().collection("radiologists").doc(userId).update({
          approved: true,
          approvedAt: admin.firestore.FieldValue.serverTimestamp(),
        });

        // Send verification email to user
        const user = await admin.auth().getUser(userId);
        const verificationLink = await admin
          .auth()
          .generateEmailVerificationLink(user.email);

        await transporter.sendMail({
          from: "PneumoScan AI <ahsaanali12live@gmail.com>",
          to: user.email,
          subject: "Your PneumoScan AI Account Has Been Approved",
          html: `
            <h2>Account Approved</h2>
            <p>Your PneumoScan AI account has been approved by our admin team.</p>
            <p>Please verify your email address to complete your registration:</p>
            <a href="${verificationLink}" style="background-color: #1a73e8; color: white; padding: 10px 20px; text-decoration: none; border-radius: 4px;">
              Verify Email
            </a>
            <p>After verification, you can login to your account using your credentials.</p>
          `,
        });

        return res.send(`
          <h2>Account Approved</h2>
          <p>A verification email has been sent to the user.</p>
          <a href="apppneumonia.web.app/admin">Back to Admin Panel</a>
        `);
      } else if (action === "reject") {
        // Delete the user account
        await admin.auth().deleteUser(userId);
        await admin.firestore().collection("radiologists").doc(userId).delete();

        // Send rejection email to user
        const userEmail = userDoc.data().email;

        await transporter.sendMail({
          from: "PneumoScan AI <ahsaanali12live@gmail.com>",
          to: userEmail,
          subject: "Your PneumoScan AI Application Has Been Rejected",
          html: `
            <h2>Application Rejected</h2>
            <p>We regret to inform you that your PneumoScan AI application has been rejected.</p>
            <p>If you believe this was a mistake, please contact our support team.</p>
          `,
        });

        return res.send(`
          <h2>Account Rejected</h2>
          <p>The user account has been deleted and the applicant has been notified.</p>
          <a href="apppneumonia.web.app/admin">Back to Admin Panel</a>
        `);
      } else {
        return res.status(400).send("Invalid action");
      }
    } catch (error) {
      console.error("Approval processing error:", error);
      return res.status(500).send("Error processing approval");
    }
  });
});
