// -------------------------------
// Firebase Init
// -------------------------------
const firebaseConfig = {
  apiKey: "AIzaSyDTmx03EnSPLt57SbdbD_5S1XsnfuaOTVA",
  authDomain: "pneumoniaweb-661c0.firebaseapp.com",
  projectId: "pneumoniaweb-661c0",
  storageBucket: "pneumoniaweb-661c0.firebasestorage.app",
  messagingSenderId: "414424891037",
  appId: "1:414424891037:web:643911cd9c8eaa98299e74",
  measurementId: "G-L6YYPPZXKN",
};

// Initialize Firebase
firebase.initializeApp(firebaseConfig);
const auth = firebase.auth();
const db = firebase.firestore();

// Email server (Node + Nodemailer)
const EMAIL_SERVER_BASE_URL = "http://localhost:4000";

// Session tracking for multi-tab support
const ADMIN_SESSION_KEY = "pneumoscan_admin_session";
let lastSessionCheck = Date.now();

// -------------------------------
// Firestore helpers 
// -------------------------------
const ROOT_COLLECTION = "PneumoniaDetectionSystem";
const ROOT_ADMIN_DOC = "Root";

function radiologistsCollection() {
  return db
    .collection(ROOT_COLLECTION)
    .doc(ROOT_ADMIN_DOC)
    .collection("radiologists & admin");
}

// Legacy collection (backward compatibility)
const legacyRadiologistsCollection = db.collection("radiologists & admin");

// Auto-migrate all legacy radiologists 
async function migrateLegacyRadiologists() {
  try {
    const legacySnap = await legacyRadiologistsCollection.get();
    if (legacySnap.empty) {
      return;
    }

    const batch = db.batch();

    legacySnap.forEach((doc) => {
      const data = doc.data() || {};
      const targetRef = radiologistsCollection().doc(doc.id);

      // Infer status if missing
      let status = data.status;
      if (!status) {
        if (data.role === "admin") {
          status = "admin";
        } else if (data.approved === true) {
          status = "approved";
        } else {
          status = "pending";
        }
      }

      const payload = {
        ...data,
        status,
        migratedFrom: "radiologists_top_level",
        migratedAt: firebase.firestore.FieldValue.serverTimestamp(),
      };

      batch.set(targetRef, payload, { merge: true });
    });

    await batch.commit();
    console.log("Legacy radiologists migrated into hierarchical structure.");
  } catch (error) {
    console.error("Error migrating legacy radiologists:", error);
  }
}

// Get radiologist doc by UID (prefers new structure, migrates legacy single doc)
async function getRadiologistDocByUid(uid) {
  const newRef = radiologistsCollection().doc(uid);
  const newSnap = await newRef.get();

  if (newSnap.exists) {
    return { doc: newSnap, from: "hierarchy" };
  }

  // Fallback legacy
  const legacyRef = legacyRadiologistsCollection.doc(uid);
  const legacySnap = await legacyRef.get();

  if (!legacySnap.exists) {
    return null;
  }

  const legacyData = legacySnap.data() || {};

  let status = legacyData.status;
  if (!status) {
    if (legacyData.role === "admin") {
      status = "admin";
    } else if (legacyData.approved === true) {
      status = "approved";
    } else {
      status = "pending";
    }
  }

  const migratedPayload = {
    ...legacyData,
    status,
    migratedFrom: "radiologists_top_level_single",
    migratedAt: firebase.firestore.FieldValue.serverTimestamp(),
  };

  await newRef.set(migratedPayload, { merge: true });
  const finalSnap = await newRef.get();

  return { doc: finalSnap, from: "migratedLegacy" };
}

// Find ADMIN doc by UID (for admin auth guard)
async function findAdminByUid(uid) {
  const info = await getRadiologistDocByUid(uid);
  if (!info) return null;
  const data = info.doc.data() || {};
  if (data.role !== "admin") return null;
  return info;
}

// Enhanced role verification with session tracking
async function verifyAdminRoleWithSession(uid) {
  try {
    // Check session conflict first
    const currentSession = localStorage.getItem(ADMIN_SESSION_KEY);
    const now = Date.now();
    
    if (currentSession) {
      const sessionData = JSON.parse(currentSession);
      // If session is from a different tab and recent (within 5 seconds)
      if (sessionData.uid !== uid && (now - sessionData.timestamp) < 5000) {
        console.warn("Session conflict detected - another tab may have logged in");
        return { valid: false, conflict: true };
      }
    }
    
    // Update session tracking
    localStorage.setItem(ADMIN_SESSION_KEY, JSON.stringify({
      uid,
      timestamp: now,
      page: 'admin'
    }));
    
    // Verify admin role from Firestore
    const adminInfo = await findAdminByUid(uid);
    if (!adminInfo) {
      return { valid: false, conflict: false, reason: "not_admin" };
    }
    
    const adminData = adminInfo.doc.data() || {};
    const status = adminData.status || (adminData.approved ? "approved" : "pending");
    
    if (status !== "approved" && !adminData.approved) {
      return { valid: false, conflict: false, reason: "not_approved" };
    }
    
    return { valid: true, data: adminData };
    
  } catch (error) {
    console.error("Role verification error:", error);
    return { valid: false, conflict: false, reason: "error" };
  }
}

// -------------------------------
// Email helper (Node server ko call karne ke liye)
// -------------------------------
async function postEmail(path, payload) {
  try {
    const res = await fetch(`${EMAIL_SERVER_BASE_URL}${path}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });

    if (!res.ok) {
      const text = await res.text().catch(() => "");
      console.warn("[Email API] Failed:", path, res.status, text);
    }
  } catch (err) {
    console.error("[Email API] Error:", path, err);
  }
}

// -------------------------------
// DOM Elements
// -------------------------------
const logoutBtn = document.getElementById("logoutBtn");

// Header date (top-right)
const todayDateElement = document.getElementById("todayDate");

// Stat cards & values
const totalRadiologistsCard = document.getElementById("totalRadiologistsCard");
const pendingApprovalsCard = document.getElementById("pendingApprovalsCard");
const totalScansCard = document.getElementById("totalScansCard");

const totalRadiologists = document.getElementById("totalRadiologists");
const pendingApprovals = document.getElementById("pendingApprovals");
const totalScans = document.getElementById("totalScans");

// Sections
const pendingApplicationsSection = document.getElementById(
  "pendingApplicationsSection"
);
const radiologistsListSection = document.getElementById(
  "radiologistsListSection"
);
const reportsListSection = document.getElementById("reportsListSection");

// Tables
const applicationsTable = document.getElementById("applicationsTable");
const radiologistsTable = document.getElementById("radiologistsTable");
const reportsTable = document.getElementById("reportsTable");

// Section close buttons
const closeRadiologistsList = document.getElementById("closeRadiologistsList");
const closePendingApplications = document.getElementById(
  "closePendingApplications"
);
const closeReportsList = document.getElementById("closeReportsList");

// Modal
const radiologistModal = document.getElementById("radiologistModal");
const radiologistDetails = document.getElementById("radiologistDetails");
const closeModalButtons = document.querySelectorAll(".close-modal");

// Current admin info (email, name, uid) for emails
let currentAdmin = null;

// -------------------------------
// Small helpers
// -------------------------------
function openModal(modal) {
  if (!modal) return;
  modal.style.display = "flex";
}

function closeModal(modal) {
  if (!modal) return;
  modal.style.display = "none";
}

function hideAllSections() {
  if (pendingApplicationsSection)
    pendingApplicationsSection.style.display = "none";
  if (radiologistsListSection) radiologistsListSection.style.display = "none";
  if (reportsListSection) reportsListSection.style.display = "none";
}

// Only today's date (no live clock needed)
function updateTodayDate() {
  if (!todayDateElement) return;
  const now = new Date();
  const options = {
    weekday: "long",
    year: "numeric",
    month: "long",
    day: "numeric",
  };
  todayDateElement.textContent = now.toLocaleDateString(undefined, options);
}
updateTodayDate();

// -------------------------------
// Admin authentication check - ENHANCED
// -------------------------------
auth.onAuthStateChanged(async (user) => {
  if (!user) {
    localStorage.removeItem(ADMIN_SESSION_KEY);
    window.location.href = "auth.html";
    return;
  }

  try {
    // Ensure legacy data migrated
    await migrateLegacyRadiologists();

    // ENHANCED: Verify admin role with session tracking
    const verification = await verifyAdminRoleWithSession(user.uid);
    
    if (!verification.valid) {
      if (verification.conflict) {
        console.warn("Session conflict - another tab may have logged in");
        alert("Another tab has logged in with a different account. Please refresh this page.");
      }
      
      // Force logout for non-admin users or role mismatches
      await auth.signOut();
      localStorage.removeItem(ADMIN_SESSION_KEY);
      window.location.href = "auth.html";
      return;
    }

    // Save current admin info for email payloads
    const adminData = verification.data;
    currentAdmin = {
      uid: user.uid,
      name: adminData.name || "",
      email: adminData.email || "",
    };

    // User is verified admin → load dashboard
    loadDashboardData();
    
    // Setup periodic role verification (every 30 seconds)
    setInterval(async () => {
      const recheck = await verifyAdminRoleWithSession(user.uid);
      if (!recheck.valid) {
        console.warn("Periodic role check failed - logging out");
        await auth.signOut();
        localStorage.removeItem(ADMIN_SESSION_KEY);
        window.location.href = "auth.html";
      }
    }, 30000);
    
  } catch (error) {
    console.error("Error checking admin status:", error);
    try {
      await auth.signOut();
      localStorage.removeItem(ADMIN_SESSION_KEY);
    } catch (_) {}
    window.location.href = "auth.html";
  }
});

// -------------------------------
// Load dashboard data (only counts)
// -------------------------------
async function loadDashboardData() {
  try {
    // Total APPROVED radiologists
    const approvedSnap = await radiologistsCollection()
      .where("role", "==", "radiologist")
      .where("approved", "==", true)
      .get();

    if (totalRadiologists) {
      totalRadiologists.textContent = approvedSnap.size;
    }

    // PENDING approvals (status = "pending")
    const pendingSnap = await radiologistsCollection()
      .where("role", "==", "radiologist")
      .where("status", "==", "pending")
      .get();

    if (pendingApprovals) {
      pendingApprovals.textContent = pendingSnap.size;
    }

    // Total scans: count all reports in new structure (collectionGroup)
    if (totalScans) {
      try {
        const scansSnap = await db.collectionGroup("reports").get();
        totalScans.textContent = scansSnap.size;
      } catch (err) {
        console.error("Error counting scans:", err);
        totalScans.textContent = "N/A";
      }
    }
  } catch (error) {
    console.error("Error loading dashboard data:", error);
  }
}

// -------------------------------
// Load pending applications (when card clicked)
// -------------------------------
async function loadPendingApplications() {
  if (!applicationsTable || !pendingApplicationsSection) return;

  hideAllSections();
  pendingApplicationsSection.style.display = "block";
  pendingApplicationsSection.scrollIntoView({ behavior: "smooth" });

  applicationsTable.innerHTML = `
    <tr>
      <td colspan="6" style="text-align:center;">Loading pending applications...</td>
    </tr>
  `;

  try {
    const querySnapshot = await radiologistsCollection()
      .where("role", "==", "radiologist")
      .where("status", "==", "pending")
      .get();

    applicationsTable.innerHTML = "";

    if (querySnapshot.empty) {
      applicationsTable.innerHTML = `
        <tr>
          <td colspan="6" style="text-align: center;">No pending applications</td>
        </tr>
      `;
      return;
    }

    querySnapshot.forEach((doc) => {
      const data = doc.data() || {};
      const row = document.createElement("tr");

      const appliedDate = data.createdAt
        ? new Date(data.createdAt.toDate()).toLocaleDateString()
        : "—";

      row.innerHTML = `
        <td>${data.name || "—"}</td>
        <td>${data.email || "—"}</td>
        <td>${data.specialization || "—"}</td>
        <td>${data.institution || "—"}</td>
        <td>${appliedDate}</td>
        <td>
          <button class="btn btn-approve" data-uid="${doc.id}">Approve</button>
          <button class="btn btn-reject" data-uid="${doc.id}">Reject</button>
        </td>
      `;

      applicationsTable.appendChild(row);
    });

    // Approve buttons
    document.querySelectorAll(".btn-approve").forEach((btn) => {
      btn.addEventListener("click", async () => {
        const uid = btn.dataset.uid;
        if (!uid) return;

        if (
          !confirm(
            "Are you sure you want to approve this user as a radiologist?"
          )
        ) {
          return;
        }

        try {
          const docRef = radiologistsCollection().doc(uid);
          const snap = await docRef.get();
          const data = snap.data() || {};

          await docRef.update({
            approved: true,
            status: "approved",
            approvedAt: firebase.firestore.FieldValue.serverTimestamp(),
          });

          // Email: radiologist approved → use /email/radiologist-status
          try {
            await postEmail("/email/radiologist-status", {
              radiologistEmail: data.email || "",
              radiologistName: data.name || "",
              status: "approved",
            });
          } catch (emailErr) {
            console.error(
              "Error calling radiologist-status (approved) email API:",
              emailErr
            );
          }

          alert("User approved successfully!");
          await loadDashboardData();
          await loadPendingApplications();
        } catch (error) {
          console.error("Error approving user:", error);
          alert("Error approving user: " + error.message);
        }
      });
    });

    // Reject buttons
    document.querySelectorAll(".btn-reject").forEach((btn) => {
      btn.addEventListener("click", async () => {
        const uid = btn.dataset.uid;
        if (!uid) return;

        if (!confirm("Are you sure you want to reject this application?")) {
          return;
        }

        try {
          const docRef = radiologistsCollection().doc(uid);
          const snap = await docRef.get();
          const data = snap.data() || {};

          await docRef.update({
            approved: false,
            status: "rejected",
            rejectedAt: firebase.firestore.FieldValue.serverTimestamp(),
          });

          // Email: radiologist rejected → use /email/radiologist-status
          try {
            await postEmail("/email/radiologist-status", {
              radiologistEmail: data.email || "",
              radiologistName: data.name || "",
              status: "rejected",
            });
          } catch (emailErr) {
            console.error(
              "Error calling radiologist-status (rejected) email API:",
              emailErr
            );
          }

          alert("User rejected successfully!");
          await loadDashboardData();
          await loadPendingApplications();
        } catch (error) {
          console.error("Error rejecting user:", error);
          alert("Error rejecting user: " + error.message);
        }
      });
    });
  } catch (error) {
    console.error("Error loading pending applications:", error);
    applicationsTable.innerHTML = `
      <tr>
        <td colspan="6" style="text-align: center; color: #e53935;">
          Error loading pending applications
        </td>
      </tr>
    `;
  }
}

// -------------------------------
// Load active radiologists list
// -------------------------------
function loadRadiologistsList() {
  if (!radiologistsTable || !radiologistsListSection) return;

  hideAllSections();
  radiologistsListSection.style.display = "block";
  radiologistsListSection.scrollIntoView({ behavior: "smooth" });

  radiologistsTable.innerHTML = `
    <tr>
      <td colspan="7" style="text-align:center;">Loading radiologists...</td>
    </tr>
  `;

  radiologistsCollection()
    .where("role", "==", "radiologist")
    .where("status", "==", "approved")
    .get()
    .then((querySnapshot) => {
      radiologistsTable.innerHTML = "";

      if (querySnapshot.empty) {
        radiologistsTable.innerHTML = `
          <tr>
            <td colspan="7" style="text-align: center;">No active radiologists found</td>
          </tr>
        `;
        return;
      }

      querySnapshot.forEach((doc) => {
        const data = doc.data() || {};
        const row = document.createElement("tr");

        const approvedDate = data.approvedAt
          ? new Date(data.approvedAt.toDate()).toLocaleDateString()
          : "—";

        row.innerHTML = `
          <td>${data.name || "—"}</td>
          <td>${data.email || "—"}</td>
          <td>${data.specialization || "—"}</td>
          <td>${data.institution || "—"}</td>
          <td>${approvedDate}</td>
          <td class="status-approved">Active</td>
          <td>
            <button class="btn btn-view btn-view-radiologist" data-uid="${
              doc.id
            }">View</button>
            <button class="btn btn-deactivate" data-uid="${
              doc.id
            }">Deactivate</button>
          </td>
        `;

        radiologistsTable.appendChild(row);
      });

      // View details
      document.querySelectorAll(".btn-view-radiologist").forEach((btn) => {
        btn.addEventListener("click", () => {
          const uid = btn.dataset.uid;
          if (uid) {
            showRadiologistDetails(uid);
          }
        });
      });

      // Deactivate radiologist
      document.querySelectorAll(".btn-deactivate").forEach((btn) => {
        btn.addEventListener("click", async () => {
          const uid = btn.dataset.uid;
          if (!uid) return;

          if (
            !confirm(
              "Are you sure you want to deactivate this radiologist account?"
            )
          ) {
            return;
          }

          try {
            const docRef = radiologistsCollection().doc(uid);
            const snap = await docRef.get();
            const data = snap.data() || {};

            await docRef.update({
              approved: false,
              status: "deactivated",
              deactivatedAt: firebase.firestore.FieldValue.serverTimestamp(),
            });

            // All approved admins ko bhi fetch karna (future use ke liye)
            let adminEmails = [];
            try {
              const adminsSnap = await radiologistsCollection()
                .where("role", "==", "admin")
                .where("status", "==", "approved")
                .get();

              adminEmails = adminsSnap.docs
                .map((d) => (d.data() && d.data().email) || null)
                .filter((x) => !!x);
            } catch (adminErr) {
              console.error(
                "Error fetching approved admins for deactivation email:",
                adminErr
              );
            }

            // Email: radiologist-deactivated
            try {
              await postEmail("/email/radiologist-deactivated", {
                radiologistEmail: data.email || "",
                radiologistName: data.name || "",
                specialization: data.specialization || "",
                institution: data.institution || "",
                deactivatedByEmail: currentAdmin?.email || null,
                deactivatedByName: currentAdmin?.name || null,
                adminEmails, // currently server.js sirf radiologist ko mail bhejta hai (extra fields ignore ho jayengi)
              });
            } catch (emailErr) {
              console.error(
                "Error calling radiologist-deactivated email API:",
                emailErr
              );
            }

            alert("Radiologist deactivated successfully!");
            loadRadiologistsList();
            loadDashboardData();
          } catch (error) {
            console.error("Error deactivating radiologist:", error);
            alert("Error deactivating radiologist: " + error.message);
          }
        });
      });
    })
    .catch((error) => {
      console.error("Error loading radiologists:", error);
      radiologistsTable.innerHTML = `
        <tr>
          <td colspan="7" style="text-align: center; color: #e53935;">
            Error loading radiologists
          </td>
        </tr>
      `;
    });
}

// -------------------------------
// Load all reports (Total Scans → list)
// -------------------------------
async function loadReportsList() {
  if (!reportsTable || !reportsListSection) return;

  hideAllSections();
  reportsListSection.style.display = "block";
  reportsListSection.scrollIntoView({ behavior: "smooth" });

  reportsTable.innerHTML = `
    <tr>
      <td colspan="5" style="text-align:center;">Loading reports...</td>
    </tr>
  `;

  try {
    const reportsSnap = await db.collectionGroup("reports").get();

    reportsTable.innerHTML = "";

    if (reportsSnap.empty) {
      reportsTable.innerHTML = `
        <tr>
          <td colspan="5" style="text-align:center;">No reports found</td>
        </tr>
      `;
      return;
    }

    reportsSnap.forEach((doc) => {
      const data = doc.data() || {};
      const row = document.createElement("tr");

      // Created date: try multiple fields, including "date" from your reports
      let createdDate = "—";
      try {
        if (data.createdAt && typeof data.createdAt.toDate === "function") {
          createdDate = new Date(data.createdAt.toDate()).toLocaleString();
        } else if (data.timestamp && typeof data.timestamp.toDate === "function") {
          createdDate = new Date(data.timestamp.toDate()).toLocaleString();
        } else if (data.date && typeof data.date.toDate === "function") {
          // Firestore Timestamp stored in "date"
          createdDate = new Date(data.date.toDate()).toLocaleString();
        } else if (typeof data.date === "string") {
          // Simple string date
          createdDate = data.date;
        }
      } catch (e) {
        console.warn("Error parsing report date for doc", doc.id, e);
      }

      const patientName =
        data.patientName ||
        data.patient_name ||
        data.name ||
        data.patientId ||
        "—";

      const gender = data.gender || data.patientGender || "—";

      const radiologistName =
        data.radiologistName ||
        data.radiologist ||
        data.doctorName ||
        data.createdByName ||
        data.createdByEmail ||
        "—";

      const resultValue =
        data.result || // e.g. "Normal", "Bacterial Pneumonia"
        data.resultType ||
        data.finalDiagnosis ||
        data.finalLabel ||
        data.finalResult ||
        data.diagnosis ||
        data.label ||
        "—";

      // IMPORTANT: order must match HTML header:
      // Patient Name | Gender | Radiologist | Date | Result
      row.innerHTML = `
        <td>${patientName}</td>
        <td>${gender}</td>
        <td>${radiologistName}</td>
        <td>${createdDate}</td>
        <td>${resultValue}</td>
      `;

      reportsTable.appendChild(row);
    });
  } catch (error) {
    console.error("Error loading reports:", error);
    reportsTable.innerHTML = `
      <tr>
        <td colspan="5" style="text-align:center; color:#e53935;">
          Error loading reports
        </td>
      </tr>
    `;
  }
}

// -------------------------------
// Show radiologist details in modal
// -------------------------------
function showRadiologistDetails(uid) {
  if (!uid) return;

  radiologistsCollection()
    .doc(uid)
    .get()
    .then(async (docSnap) => {
      let docToUse = docSnap;

      if (!docToUse.exists) {
        // Fallback legacy (agar koi purana doc migrate na hua ho)
        const legacySnap = await legacyRadiologistsCollection.doc(uid).get();
        if (!legacySnap.exists) {
          alert("Radiologist not found");
          return;
        }
        docToUse = legacySnap;
      }

      const data = docToUse.data() || {};

      const approvedDate = data.approvedAt
        ? new Date(data.approvedAt.toDate()).toLocaleDateString()
        : "Not available";

      const createdDate = data.createdAt
        ? new Date(data.createdAt.toDate()).toLocaleDateString()
        : "Not available";

      const statusLabel =
        data.status === "approved"
          ? '<span class="status-approved">Active</span>'
          : data.status === "pending"
          ? '<span class="status-pending">Pending</span>'
          : data.status === "rejected"
          ? '<span class="status-rejected">Rejected</span>'
          : data.status === "deactivated"
          ? '<span class="status-deactivated">Deactivated</span>'
          : data.approved
          ? '<span class="status-approved">Active</span>'
          : "Unknown";

      if (radiologistDetails) {
        radiologistDetails.innerHTML = `
          <div style="margin-bottom: 1.5rem;">
            <h4 style="margin-bottom: 0.5rem;">Personal Information</h4>
            <p><strong>Name:</strong> ${data.name || "—"}</p>
            <p><strong>Email:</strong> ${data.email || "—"}</p>
            <p><strong>Phone:</strong> ${data.phone || "Not provided"}</p>
          </div>
          
          <div style="margin-bottom: 1.5rem;">
            <h4 style="margin-bottom: 0.5rem;">Professional Information</h4>
            <p><strong>Specialization:</strong> ${
              data.specialization || "—"
            }</p>
            <p><strong>Hospital/Clinic:</strong> ${
              data.institution || "—"
            }</p>
            <p><strong>Address:</strong> ${data.address || "Not provided"}</p>
          </div>
          
          <div style="margin-bottom: 1.5rem;">
            <h4 style="margin-bottom: 0.5rem;">Account Information</h4>
            <p><strong>Account Created:</strong> ${createdDate}</p>
            <p><strong>Approved On:</strong> ${approvedDate}</p>
            <p><strong>Status:</strong> ${statusLabel}</p>
          </div>
        `;
      }

      openModal(radiologistModal);
    })
    .catch((error) => {
      console.error("Error fetching radiologist details:", error);
      alert("Error loading radiologist details");
    });
}

// -------------------------------
// Event listeners (cards, sections, modal, logout)
// -------------------------------

// Total Radiologists card → Active Radiologists list
if (totalRadiologistsCard) {
  totalRadiologistsCard.addEventListener("click", () => {
    loadRadiologistsList();
  });
}

// Pending Approvals card → Pending Applications section
if (pendingApprovalsCard) {
  pendingApprovalsCard.addEventListener("click", () => {
    loadPendingApplications();
  });
}

// Total Scans card → All Reports section
if (totalScansCard) {
  totalScansCard.addEventListener("click", () => {
    loadReportsList();
  });
}

// Close buttons for sections
if (closeRadiologistsList) {
  closeRadiologistsList.addEventListener("click", () => {
    if (radiologistsListSection) {
      radiologistsListSection.style.display = "none";
    }
  });
}

if (closePendingApplications) {
  closePendingApplications.addEventListener("click", () => {
    if (pendingApplicationsSection) {
      pendingApplicationsSection.style.display = "none";
    }
  });
}

if (closeReportsList) {
  closeReportsList.addEventListener("click", () => {
    if (reportsListSection) {
      reportsListSection.style.display = "none";
    }
  });
}

// Modal close buttons
closeModalButtons.forEach((button) => {
  button.addEventListener("click", () => {
    closeModal(radiologistModal);
  });
});

// Close modal when clicking outside
window.addEventListener("click", (event) => {
  if (event.target === radiologistModal) {
    closeModal(radiologistModal);
  }
});

// Logout with small animation text - ENHANCED
if (logoutBtn) {
  logoutBtn.addEventListener("click", (e) => {
    e.preventDefault();

    const originalText = logoutBtn.textContent;
    logoutBtn.textContent = "Logging out...";
    logoutBtn.disabled = true;

    auth
      .signOut()
      .then(() => {
        localStorage.removeItem(ADMIN_SESSION_KEY);
        alert("Logged out successfully!");
        window.location.href = "auth.html";
      })
      .catch((error) => {
        console.error("Logout error:", error);
        alert("Error logging out: " + error.message);
        logoutBtn.textContent = originalText;
        logoutBtn.disabled = false;
      });
  });
}

// Listen for storage events (for multi-tab session handling)
window.addEventListener('storage', (event) => {
  if (event.key === ADMIN_SESSION_KEY) {
    const newSession = JSON.parse(event.newValue || '{}');
    const oldSession = JSON.parse(event.oldValue || '{}');
    
    if (newSession.uid && oldSession.uid && newSession.uid !== oldSession.uid) {
      console.log("Session changed in another tab, checking current auth...");
      // Re-verify current user
      if (auth.currentUser && auth.currentUser.uid !== newSession.uid) {
        alert("Your session has been changed in another tab. This page will refresh.");
        setTimeout(() => {
          window.location.reload();
        }, 1000);
      }
    }
  }
});