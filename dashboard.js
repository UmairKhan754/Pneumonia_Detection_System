/* =========================
   BACKEND BASE
   ========================= */
const API_BASE = "http://127.0.0.1:5000"; // Flask server
const EMAIL_API_BASE = "http://127.0.0.1:4000"; // Node.js email server

// Session tracking for multi-tab support
const RADIOLOGIST_SESSION_KEY = "pneumoscan_radiologist_session";

/* =========================
   FIREBASE CONFIG
   ========================= */
const firebaseConfig = {
  apiKey: "AIzaSyDTmx03EnSPLt57SbdbD_5S1XsnfuaOTVA",
  authDomain: "pneumoniaweb-661c0.firebaseapp.com",
  projectId: "pneumoniaweb-661c0",
  storageBucket: "pneumoniaweb-661c0.firebasestorage.app",
  messagingSenderId: "414424891037",
  appId: "1:414424891037:web:643911cd9c8eaa98299e74",
  measurementId: "G-L6YYPPZXKN",
};

try {
  firebase.initializeApp(firebaseConfig);
  console.log(" Firebase ready");
} catch (e) {
  console.error(" Firebase init error:", e);
}

const auth = firebase.auth();
const db = firebase.firestore();

/* =========================
   FIRESTORE HELPERS 
   ========================= */
const ROOT_COLLECTION = "PneumoniaDetectionSystem";
const ROOT_ADMIN_DOC = "Root";

function radiologistsCollection() {
  return db.collection(ROOT_COLLECTION).doc(ROOT_ADMIN_DOC).collection("radiologists & admin");
}

function reportsCollectionForUser(uid) {
  return radiologistsCollection().doc(uid).collection("reports");
}

// Legacy collections (for auto-migration + clean-up)
const legacyRadiologistsCollection = db.collection("radiologists");
const legacyReportsCollection = db.collection("reports");

/**
 * Enhanced radiologist role verification with session tracking
 */
async function verifyRadiologistRoleWithSession(uid) {
  try {
    // Check session conflict first
    const currentSession = localStorage.getItem(RADIOLOGIST_SESSION_KEY);
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
    localStorage.setItem(RADIOLOGIST_SESSION_KEY, JSON.stringify({
      uid,
      timestamp: now,
      page: 'dashboard'
    }));
    
    // Get radiologist doc
    const newRef = radiologistsCollection().doc(uid);
    let snap = await newRef.get();
    
    if (!snap.exists) {
      // Try legacy
      const legacyRef = legacyRadiologistsCollection.doc(uid);
      const legacySnap = await legacyRef.get();
      
      if (!legacySnap.exists) {
        return { valid: false, conflict: false, reason: "not_found" };
      }
      
      const legacyData = legacySnap.data() || {};
      
      // Check if user is admin trying to access radiologist dashboard
      if (legacyData.role === "admin") {
        return { valid: false, conflict: false, reason: "is_admin" };
      }
      
      let status = legacyData.status;
      if (!status) {
        status = legacyData.approved === false ? "pending" : "approved";
      }
      
      // Auto-migrate
      await newRef.set(
        {
          ...legacyData,
          status,
          migratedFrom: "radiologists_top_level_single",
          migratedAt: firebase.firestore.FieldValue.serverTimestamp(),
        },
        { merge: true }
      );
      
      snap = await newRef.get();
    }
    
    const data = snap.data() || {};
    
    // IMPORTANT: Check if user is admin trying to access radiologist dashboard
    if (data.role === "admin") {
      return { valid: false, conflict: false, reason: "is_admin" };
    }
    
    // Check if radiologist is approved
    const status = data.status || (data.approved ? "approved" : "pending");
    
    if (status !== "approved" && !data.approved) {
      return { valid: false, conflict: false, reason: "not_approved" };
    }
    
    return { valid: true, data };
    
  } catch (error) {
    console.error("Role verification error:", error);
    return { valid: false, conflict: false, reason: "error" };
  }
}

/**
 * Ensure radiologist doc for CURRENT USER is present in the new hierarchy.
 * - If already exists in new path → return it.
 * - Else, try to migrate from legacy "radiologists/{uid}".
 * - If still not found → create a minimal doc from Auth data.
 */
async function getOrCreateRadiologistDocSnapshot(currentUser) {
  if (!currentUser) return null;
  const uid = currentUser.uid;

  const newRef = radiologistsCollection().doc(uid);
  let snap = await newRef.get();
  if (snap.exists) return snap;

  // Try legacy
  const legacyRef = legacyRadiologistsCollection.doc(uid);
  const legacySnap = await legacyRef.get();

  let data;
  let migratedFrom = "created_on_dashboard";

  if (legacySnap.exists) {
    data = legacySnap.data() || {};
    migratedFrom = "radiologists_top_level";
  } else {
    data = {
      name: currentUser.displayName || "Radiologist",
      email: currentUser.email,
      role: "radiologist",
      approved: true,
      createdAt: firebase.firestore.FieldValue.serverTimestamp(),
    };
  }

  let status = data.status;
  if (!status) {
    status = data.approved === false ? "pending" : "approved";
  }

  await newRef.set(
    {
      ...data,
      status,
      migratedFrom,
      migratedAt: firebase.firestore.FieldValue.serverTimestamp(),
    },
    { merge: true }
  );

  snap = await newRef.get();
  return snap;
}

/**
 * Auto-migrate ALL legacy reports for CURRENT USER into nested subcollection.
 * - Copies each legacy doc to: PneumoniaDetectionSystem/Admin/radiologists/{uid}/reports/{sameId}
 * - Deletes legacy docs after migration (idempotent).
 */
async function migrateLegacyReportsForCurrentUser(currentUser) {
  if (!currentUser) return;
  const uid = currentUser.uid;

  try {
    const legacySnap = await legacyReportsCollection.where("radiologistId", "==", uid).get();
    if (legacySnap.empty) return;

    const batch = db.batch();
    const targetColl = reportsCollectionForUser(uid);

    legacySnap.forEach((doc) => {
      const data = doc.data() || {};
      const destRef = targetColl.doc(doc.id);
      batch.set(
        destRef,
        {
          ...data,
          migratedFrom: "reports_top_level",
          migratedAt: firebase.firestore.FieldValue.serverTimestamp(),
        },
        { merge: true }
      );
      batch.delete(doc.ref);
    });

    await batch.commit();
    console.log("Legacy reports migrated for user:", uid);
  } catch (err) {
    console.error("Error migrating legacy reports:", err);
  }
}

/**
 * Fetch all approved admin emails (for notification on radiologist delete)
 */
async function fetchApprovedAdminEmails() {
  try {
    const snap = await radiologistsCollection()
      .where("role", "==", "admin")
      .where("status", "==", "approved")
      .get();

    const emails = [];
    snap.forEach((doc) => {
      const d = doc.data() || {};
      if (d.email) emails.push(d.email);
    });
    return emails;
  } catch (err) {
    console.error("Error fetching approved admin emails:", err);
    return [];
  }
}

/**
 * Trigger radiologist-deleted email (to radiologist + approved admins)
 */
async function sendRadiologistDeletedEmail(radiologistEmail, radiologistName) {
  if (!radiologistEmail) return;
  try {
    const adminEmails = await fetchApprovedAdminEmails();
    const payload = {
      radiologistEmail,
      radiologistName: radiologistName || "Radiologist",
      adminEmails,
    };

    await fetch(`${EMAIL_API_BASE}/email/radiologist-deleted`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify(payload),
    });

    console.log("Radiologist deletion email trigger sent:", payload);
  } catch (err) {
    console.error("Error calling /email/radiologist-deleted:", err);
  }
}

/* =========================
   DOM SAFE GET
   ========================= */
const $id = (i) => document.getElementById(i);

const el = {
  // Top + Theme
  userAvatar: $id("userAvatar"),
  dropdownMenu: $id("dropdownMenu"),
  logoutBtn: $id("logoutBtn"),
  themeToggle: $id("themeToggle"),
  darkModeToggle: $id("darkModeToggle"),
  pages: document.querySelectorAll(".page"),
  navLinks: document.querySelectorAll(".nav-link"),
  sidebarLinks: document.querySelectorAll(".sidebar-link"),

  // Patient form
  patientForm: $id("patientForm"),
  patientName: $id("patientName"),
  patientAge: $id("patientAge"),
  patientGender: $id("patientGender"),

  // Upload / Analysis
  xrayUpload: $id("xrayUpload"),
  xrayFile: $id("xrayFile"),
  xrayPreview: $id("xrayPreview"),
  analyzeBtn: $id("analyzeBtn"),
  furtherAnalysisBtn: $id("furtherAnalysisBtn"),
  saveReportBtn: $id("saveReportBtn"),

  // Analysis Inline Card (Slider-like panel)
  analysisSlider: $id("analysisSlider"),
  closeAnalysisSlider: $id("closeAnalysisSlider"),

  originalImageBox: $id("originalImageBox"),
  heatmapImageBox: $id("heatmapImageBox"),
  sliderOriginalImg: $id("sliderOriginalImg"),
  sliderHeatmapImg: $id("sliderHeatmapImg"),
  heatmapStatusText: $id("heatmapStatusText"),

  // Patient details display (stacked)
  sliderPatientName: $id("sliderPatientName"),
  sliderPatientAge: $id("sliderPatientAge"),
  sliderPatientGender: $id("sliderPatientGender"),

  // Results
  sliderResultValue: $id("sliderResultValue"),
  sliderResultConfidence: $id("sliderResultConfidence"),
  clipCaptionText: $id("clipCaptionText"), // Now used for "Comment"

  // analysis overlay (4 phases)
  analysisProgressContainer: $id("analysisProgressContainer"),
  phase1: $id("phase1"),
  phase2: $id("phase2"),
  phase3: $id("phase3"),
  phase4: $id("phase4"),
  phase1Progress: $id("phase1Progress"),
  phase2Progress: $id("phase2Progress"),
  phase3Progress: $id("phase3Progress"),
  phase4Progress: $id("phase4Progress"),
  phase1Text: $id("phase1Text"),
  phase2Text: $id("phase2Text"),
  phase3Text: $id("phase3Text"),
  phase4Text: $id("phase4Text"),

  // Result Announcement Modal (kept)
  resultAnnouncementModal: $id("resultAnnouncementModal"),
  announcementIcon: $id("announcementIcon"),
  announcementTitle: $id("announcementTitle"),
  announcementResult: $id("announcementResult"),
  resultType: $id("resultType"),
  resultConfidence: $id("resultConfidence"),
  announcementMessage: $id("announcementMessage"),
  closeAnnouncementBtn: $id("closeAnnouncementBtn"),

  // validation popup (unchanged)
  validationPopup: $id("validationPopup"),
  validationIcon: $id("validationIcon"),
  validationTitle: $id("validationTitle"),
  validationMessage: $id("validationMessage"),
  validationProgressBar: $id("validationProgressBar"),

  // History
  historyTableBody: $id("historyTableBody"),
  historySearch: $id("historySearch"),

  // Settings/Modals (kept)
  changePasswordModal: $id("change-password-modal"),
  changePasswordForm: $id("changePasswordForm"),
  closePasswordModal: $id("close-password-modal"),
  currentPassword: $id("current-password"),
  newPassword: $id("new-password"),
  confirmPassword: $id("confirm-password"),
  deleteAccountModal: $id("delete-account-modal"),
  deleteAccountForm: $id("deleteAccountForm"),
  closeDeleteModal: $id("close-delete-modal"),
  deletePassword: $id("delete-password"),

  // Settings toggles - Email Notifications removed
  pushNotifications: $id("pushNotifications"),
};

let currentUser = null;
let userData = null;
let ALL_REPORTS = [];
let notificationSettings = { push: true }; // Only push

/* ===========================================================
   State for the analysis session
   =========================================================== */
const AnalysisState = {
  file: null,
  validated: false,
  initialDone: false,
  furtherDone: false,
  stage1: null,
  stage2: null,
  finalPrediction: null,
  finalConfidence: null,
  heatmapUrl: null,
  commentText: null, // CHANGED: captionText → commentText
  lastCaseType: null, // "Normal" | "Pneumonia"
  isNormalCase: false, //  Track if this is a Normal case
};

function resetAnalysisState() {
  AnalysisState.file = null;
  AnalysisState.validated = false;
  AnalysisState.initialDone = false;
  AnalysisState.furtherDone = false;
  AnalysisState.stage1 = null;
  AnalysisState.stage2 = null;
  AnalysisState.finalPrediction = null;
  AnalysisState.finalConfidence = null;
  AnalysisState.heatmapUrl = null;
  AnalysisState.commentText = null;
  AnalysisState.lastCaseType = null;
  AnalysisState.isNormalCase = false;
}

/* =========================
   INIT / AUTH - ENHANCED
   ========================= */
document.addEventListener("DOMContentLoaded", init);

function init() {
  // prevent default # links
  document.addEventListener("click", (e) => {
    const a = e.target.closest('a[href="#"]');
    if (a) e.preventDefault();
  });

  if (el.analyzeBtn) {
    el.analyzeBtn.disabled = true;
    el.analyzeBtn.title = "Upload a valid chest X-ray first";
  }
  if (el.furtherAnalysisBtn) {
    el.furtherAnalysisBtn.disabled = true;
  }
  if (el.saveReportBtn) {
    el.saveReportBtn.disabled = true;
  }

  checkAuthState();
  setupEventListeners();
  loadThemePreference();
  loadNotificationSettings();
  showPage("upload");
}

function checkAuthState() {
  auth.onAuthStateChanged(
    async (user) => {
      if (!user) {
        localStorage.removeItem(RADIOLOGIST_SESSION_KEY);
        localStorage.removeItem("currentUser");
        window.location.href = "index.html";
        return;
      }

      try {
        // ENHANCED: Verify radiologist role with session tracking
        const verification = await verifyRadiologistRoleWithSession(user.uid);
        
        if (!verification.valid) {
          if (verification.conflict) {
            console.warn("Session conflict - another tab may have logged in");
            alert("Another tab has logged in with a different account. Please refresh this page.");
          }
          
          if (verification.reason === "is_admin") {
            console.error("Admin trying to access radiologist dashboard - redirecting to admin login");
            showToast("Admin account detected. Please use admin login.", "error");
          }
          
          // Force logout for non-radiologist users or role mismatches
          await auth.signOut();
          localStorage.removeItem(RADIOLOGIST_SESSION_KEY);
          localStorage.removeItem("currentUser");
          window.location.href = "auth.html";
          return;
        }

        currentUser = user;
        localStorage.setItem(
          "currentUser",
          JSON.stringify({
            uid: user.uid,
            email: user.email,
            displayName: user.displayName,
          })
        );

        // Ensure radiologist doc exists in new structure
        await getOrCreateRadiologistDocSnapshot(user);
        // Auto-migrate legacy reports for this user
        await migrateLegacyReportsForCurrentUser(user);

        await loadUserData();
        updateUserAvatar();
        
        // Setup periodic role verification (every 30 seconds)
        setInterval(async () => {
          const recheck = await verifyRadiologistRoleWithSession(user.uid);
          if (!recheck.valid) {
            console.warn("Periodic role check failed - logging out");
            await auth.signOut();
            localStorage.removeItem(RADIOLOGIST_SESSION_KEY);
            localStorage.removeItem("currentUser");
            window.location.href = "auth.html";
          }
        }, 30000);
        
      } catch (error) {
        console.error("Error checking auth state:", error);
        try {
          await auth.signOut();
          localStorage.removeItem(RADIOLOGIST_SESSION_KEY);
          localStorage.removeItem("currentUser");
        } catch (_) {}
        window.location.href = "auth.html";
      }
    },
    (err) => {
      console.error(err);
      window.location.href = "index.html";
    }
  );
}

function updateUserAvatar() {
  if (!el.userAvatar) return;
  let initials = "DR";
  if (userData?.name) {
    initials = userData.name
      .split(" ")
      .map((s) => s[0])
      .join("")
      .toUpperCase();
  } else if (currentUser?.email) {
    initials = currentUser.email[0].toUpperCase();
  }
  el.userAvatar.textContent = initials;
}

async function loadUserData() {
  try {
    const snap = await getOrCreateRadiologistDocSnapshot(currentUser);
    userData = snap && snap.exists
      ? snap.data()
      : {
          name: currentUser.displayName || "Radiologist",
          email: currentUser.email,
          specialization: "Not specified",
          institution: "Not specified",
          phone: "Not specified",
          address: "Not specified",
        };
  } catch (e) {
    console.error(e);
    userData = { name: "Radiologist", email: currentUser?.email };
  }
  updateProfileUI();
}

/* =========================
   THEME / TOAST
   ========================= */
function toggleTheme() {
  const isDark = document.documentElement.getAttribute("data-theme") === "dark";
  if (isDark) {
    document.documentElement.removeAttribute("data-theme");
    localStorage.setItem("theme", "light");
    if (el.themeToggle)
      el.themeToggle.innerHTML = '<i class="fas fa-moon"></i> Dark Mode';
  } else {
    document.documentElement.setAttribute("data-theme", "dark");
    localStorage.setItem("theme", "dark");
    if (el.themeToggle)
      el.themeToggle.innerHTML = '<i class="fas fa-sun"></i> Light Mode';
  }
  if (el.darkModeToggle) el.darkModeToggle.checked = !isDark;
}
function loadThemePreference() {
  const t = localStorage.getItem("theme") || "light";
  if (t === "dark") {
    document.documentElement.setAttribute("data-theme", "dark");
    if (el.darkModeToggle) el.darkModeToggle.checked = true;
    if (el.themeToggle)
      el.themeToggle.innerHTML = '<i class="fas fa-sun"></i> Light Mode';
  }
}

// Toast gated by Push Notifications setting
function showToast(msg, type = "info") {
  if (!notificationSettings.push) {
    console.log(`[Toast suppressed] ${msg}`);
    return;
  }

  const c = document.getElementById("toastContainer");
  if (!c) return;
  const d = document.createElement("div");
  d.className = `toast ${type}`;
  d.textContent = msg;
  c.appendChild(d);
  setTimeout(() => d.remove(), 4500);
}

/* =========================
   NAV
   ========================= */
function showPage(name) {
  el.pages.forEach((p) => {
    p.style.display = "none";
    p.classList.remove("active");
  });
  const tgt = $id(`${name}-page`);
  if (tgt) {
    tgt.style.display = "block";
    tgt.classList.add("active");
  }
  document.querySelectorAll(`[data-page]`).forEach((a) => a.classList.remove("active"));
  document.querySelectorAll(`[data-page="${name}"]`).forEach((a) => a.classList.add("active"));

  if (name === "history") loadHistory();
}

/* =========================
   PROFILE
   ========================= */
function S(node, value) {
  if (node) node.textContent = value ?? "Not specified";
}
function updateProfileUI() {
  if (!userData) return;
  let initials = "DR";
  if (userData.name)
    initials = userData.name
      .split(" ")
      .map((s) => s[0])
      .join("")
      .toUpperCase();
  const profileAvatar = $id("profileAvatar");
  if (profileAvatar) profileAvatar.textContent = initials;

  S($id("profileName"), userData.name ? `Dr. ${userData.name}` : "Dr. Radiologist");
  S($id("profileEmail"), currentUser?.email || "—");

  S($id("profileSpecializationDisplay"), userData.specialization);
  S($id("profileHospitalDisplay"), userData.institution);
  S($id("profilePhoneDisplay"), userData.phone);
  S($id("profileAddressDisplay"), userData.address);

  const spI = $id("profileSpecializationInput");
  const hsI = $id("profileHospitalInput");
  const phI = $id("profilePhoneInput");
  const adI = $id("profileAddressInput");
  if (spI) spI.value = userData.specialization || "";
  if (hsI) hsI.value = userData.institution || "";
  if (phI) phI.value = userData.phone || "";
  if (adI) adI.value = userData.address || "";
}

function enableProfileEditing() {
  ["profileSpecialization", "profileHospital", "profilePhone", "profileAddress"].forEach((k) => {
    $id(`${k}Display`)?.style && ($id(`${k}Display`).style.display = "none");
    $id(`${k}Input`)?.style && ($id(`${k}Input`).style.display = "block");
  });
  const editBtn = $id("editProfileBtn");
  const actions = $id("profileActions");
  if (editBtn) editBtn.style.display = "none";
  if (actions) actions.style.display = "block";
}

function disableProfileEditing() {
  ["profileSpecialization", "profileHospital", "profilePhone", "profileAddress"].forEach((k) => {
    $id(`${k}Display`)?.style && ($id(`${k}Display`).style.display = "block");
    $id(`${k}Input`)?.style && ($id(`${k}Input`).style.display = "none");
  });
  const editBtn = $id("editProfileBtn");
  const actions = $id("profileActions");
  if (editBtn) editBtn.style.display = "block";
  if (actions) actions.style.display = "none";
}

async function saveProfileChanges() {
  const payload = {
    specialization: $id("profileSpecializationInput")?.value || "",
    institution: $id("profileHospitalInput")?.value || "",
    phone: $id("profilePhoneInput")?.value || "",
    address: $id("profileAddressInput")?.value || "",
  };
  if (!payload.specialization || !payload.institution) {
    showToast(" Specialization and Hospital are required", "error");
    return;
  }
  const saveBtn = $id("saveProfileBtn");
  try {
    if (saveBtn) {
      saveBtn.innerHTML = '<i class="fas fa-spinner fa-spin"></i> Saving...';
      saveBtn.disabled = true;
    }
    await radiologistsCollection().doc(currentUser.uid).set(payload, { merge: true });
    userData = { ...userData, ...payload };
    updateProfileUI();
    disableProfileEditing();
    showToast(" Profile updated successfully", "success");
  } catch (e) {
    console.error(e);
    showToast(" Error updating profile", "error");
  } finally {
    if (saveBtn) {
      saveBtn.innerHTML = "Save Changes";
      saveBtn.disabled = false;
    }
  }
}

/* =========================
   VALIDATION POPUP (UNCHANGED)
   ========================= */
function showValidationPopup() {
  if (!el.validationPopup) return;
  el.validationIcon.className = "validation-icon validating";
  el.validationIcon.innerHTML = '<i class="fas fa-spinner fa-spin"></i>';
  el.validationTitle.textContent = "Validating X-ray Image";
  el.validationMessage.textContent = "Checking if this is a valid chest X-ray...";
  el.validationProgressBar.style.width = "0%";
  el.validationPopup.style.display = "block";
  setTimeout(() => {
    el.validationProgressBar.style.width = "35%";
  }, 150);
  setTimeout(() => {
    el.validationProgressBar.style.width = "70%";
    el.validationMessage.textContent = "Checking format & quality...";
  }, 650);
  setTimeout(() => {
    el.validationProgressBar.style.width = "90%";
    el.validationMessage.textContent = "Verifying medical criteria...";
  }, 1200);
}

function hideValidationPopup(success = true, msg = "") {
  if (!el.validationPopup) return;
  el.validationProgressBar.style.width = "100%";
  if (success) {
    el.validationIcon.className = "validation-icon success";
    el.validationIcon.innerHTML = '<i class="fas fa-check"></i>';
    el.validationTitle.textContent = "Image Validated";
    el.validationMessage.textContent = "Ready for AI analysis!";
    setTimeout(() => {
      el.validationPopup.style.display = "none";
      showToast(" Image validated successfully!", "success");
    }, 900);
  } else {
    el.validationIcon.className = "validation-icon error";
    el.validationIcon.innerHTML = '<i class="fas fa-times"></i>';
    el.validationTitle.textContent = "Validation Failed";
    el.validationMessage.textContent = msg || "Invalid image";
    setTimeout(() => {
      el.validationPopup.style.display = "none";
      showToast(` ${msg || "Image validation failed"}`, "error");
    }, 1200);
  }
}

/* =========================
   UPLOAD HANDLER (Validation first — UNCHANGED)
   ========================= */
async function handleXrayUpload(e) {
  const file = e.target.files?.[0];
  if (!file) return;

  showValidationPopup();

  try {
    // basic client check
    const okTypeList = ["image/jpeg", "image/png", "image/jpg", "image/bmp"];
    const mime = (file.type || "").toLowerCase();
    const typeOk = okTypeList.includes(mime);

    const dataUrl = await new Promise((resolve, reject) => {
      const r = new FileReader();
      r.onload = () => resolve(r.result);
      r.onerror = reject;
      r.readAsDataURL(file);
    });

    const dimOk = await new Promise((res) => {
      const img = new Image();
      img.onload = () => res(img.width >= 224 && img.height >= 224);
      img.onerror = () => res(false);
      img.src = dataUrl;
    });

    const backend = await validateWithBackendSilent(file);

    if (!typeOk) throw new Error("Please upload JPEG/PNG/BMP only");
    if (!dimOk) throw new Error("Image too small/invalid");
    if (!backend.ok || !backend.isValid)
      throw new Error(backend.error || "Server rejected image");

    // success
    AnalysisState.file = file;
    AnalysisState.validated = true;
    AnalysisState.initialDone = false;
    AnalysisState.furtherDone = false;
    AnalysisState.stage1 = null;
    AnalysisState.stage2 = null;
    AnalysisState.heatmapUrl = null;
    AnalysisState.commentText = null;
    AnalysisState.isNormalCase = false;

    el.xrayPreview.src = dataUrl;
    el.xrayPreview.style.display = "block";
    el.xrayUpload.innerHTML =
      '<i class="fas fa-check-circle"></i> Image Ready for Analysis';

    if (el.analyzeBtn) {
      el.analyzeBtn.style.display = "inline-flex";
      el.analyzeBtn.disabled = false;
      el.analyzeBtn.title = "Click to analyze X-ray";
    }
    if (el.furtherAnalysisBtn) el.furtherAnalysisBtn.disabled = true;
    if (el.saveReportBtn) el.saveReportBtn.disabled = false;

    hideValidationPopup(true);
  } catch (err) {
    console.error(err);
    if (el.analyzeBtn) {
      el.analyzeBtn.disabled = true;
      el.analyzeBtn.title = err.message;
    }
    hideValidationPopup(false, err.message);
    resetXrayUI(true);
  }
}

async function validateWithBackendSilent(file) {
  try {
    const fd = new FormData();
    fd.append("file", file);
    console.log("↗ POST /validateXray");
    const r = await fetch(`${API_BASE}/validateXray`, { method: "POST", body: fd });
    console.log("↙ /validateXray", r.status);
    if (!r.ok) return { ok: false, isValid: false, error: `Server error ${r.status}` };
    const d = await r.json().catch(() => ({}));
    const isValid =
      d.is_valid === true ||
      d.is_valid_chest_xray === true ||
      d.valid === true ||
      d?.report?.final_decision === true;
    return { ok: true, isValid, confidence: d.confidence_like ?? d.confidence, report: d.report };
  } catch (e) {
    return { ok: false, isValid: false, error: e.message };
  }
}

/* =========================
   ANALYSIS OVERLAY (Updated for Normal/Pneumonia flow)
   ========================= */
const PHASES = [
  { el: () => el.phase1, prog: () => el.phase1Progress, text: () => el.phase1Text, default: "Detecting pneumonia in X-ray..." },
  { el: () => el.phase2, prog: () => el.phase2Progress, text: () => el.phase2Text, default: "Detecting type of pneumonia..." },
  { el: () => el.phase3, prog: () => el.phase3Progress, text: () => el.phase3Text, default: "Generating Analyzed X-Ray..." },
  { el: () => el.phase4, prog: () => el.phase4Progress, text: () => el.phase4Text, default: "Generating Comment..." },
];

function resetAllPhases() {
  PHASES.forEach((p) => {
    const e = p.el(),
      g = p.prog(),
      t = p.text();
    if (e) {
      e.style.display = "none";
      e.className = "analysis-phase";
    }
    if (g) g.style.width = "0%";
    if (t) t.textContent = p.default;
  });
}

function showContainer() {
  if (el.analysisProgressContainer) el.analysisProgressContainer.style.display = "flex";
}
function hideContainer() {
  if (el.analysisProgressContainer) el.analysisProgressContainer.style.display = "none";
}

function setActivePhase(idx, label) {
  PHASES.forEach((p, i) => {
    const e = p.el(),
      g = p.prog(),
      t = p.text();
    if (!e) return;
    if (i === idx) {
      e.style.display = "block";
      e.className = "analysis-phase active";
      if (t) t.textContent = label || p.default;
      setTimeout(() => {
        if (g) g.style.width = "20%";
      }, 80);
    } else {
      e.style.display = "none";
      e.className = "analysis-phase";
      if (g) g.style.width = "0%";
    }
  });
}

function completePhase(idx, finalMsg) {
  const p = PHASES[idx];
  if (!p) return;
  const e = p.el(),
    g = p.prog(),
    t = p.text();
  if (g) g.style.width = "100%";
  if (t && finalMsg) t.textContent = finalMsg;
  if (e) e.className = "analysis-phase completed";
}

const PHASE_MS = 2000;
function sleep(ms) {
  return new Promise((res) => setTimeout(res, ms));
}
function animateProgress(idx, duration = PHASE_MS, startPct = 20, endPct = 100) {
  const p = PHASES[idx];
  if (!p) return;
  const bar = p.prog && p.prog();
  if (!bar) return;

  const start = performance.now();
  function step(now) {
    const t = Math.min(1, (now - start) / duration);
    const pct = startPct + (endPct - startPct) * t;
    bar.style.width = `${pct}%`;
    if (t < 1) requestAnimationFrame(step);
  }
  requestAnimationFrame(step);
}
async function runPhase(idx, label, workFn) {
  setActivePhase(idx, label);
  animateProgress(idx, PHASE_MS, 20, 100);
  const t0 = performance.now();
  try {
    if (typeof workFn === "function") {
      await workFn();
    }
  } finally {
    const elapsed = performance.now() - t0;
    if (elapsed < PHASE_MS) await sleep(PHASE_MS - elapsed);
    completePhase(idx, `✓ ${label.replace(/\.\.\.$/, " complete")}`);
  }
}

/* =========================
   SLIDER HELPERS (Updated for Normal/Pneumonia cases)
   ========================= */
function openAnalysisSlider() {
  if (el.analysisSlider) el.analysisSlider.style.display = "block";
}
function closeAnalysisSliderUI() {
  if (el.analysisSlider) el.analysisSlider.style.display = "none";
}

function initSliderLoadingState() {
  if (!el.xrayPreview?.src) return;

  // Original image
  if (el.sliderOriginalImg) {
    el.sliderOriginalImg.src = el.xrayPreview.src;
    el.sliderOriginalImg.style.display = "block";
  }

  // Analyzed X-Ray panel reset
  if (el.sliderHeatmapImg) {
    el.sliderHeatmapImg.src = "";
    el.sliderHeatmapImg.style.display = "none";
  }
  if (el.heatmapStatusText) {
    el.heatmapStatusText.innerHTML =
      '<i class="fas fa-info-circle"></i> Analyzed view unavailable. Use <strong>Further Analysis</strong> to generate analyzed view & comment.';
  }

  // Patient details (stacked)
  if (el.sliderPatientName) el.sliderPatientName.textContent = el.patientName?.value?.trim() || "—";
  if (el.sliderPatientAge) el.sliderPatientAge.textContent = el.patientAge?.value?.trim() || "—";
  if (el.sliderPatientGender) el.sliderPatientGender.textContent = el.patientGender?.value?.trim() || "—";

  // Result
  if (el.sliderResultValue) {
    el.sliderResultValue.textContent = "Analyzing...";
    el.sliderResultValue.className = "result-value";
  }
  if (el.sliderResultConfidence) el.sliderResultConfidence.textContent = "Confidence: --%";
  if (el.clipCaptionText) el.clipCaptionText.textContent = "Comment will appear here after analysis.";

  // Buttons - Further Analysis initially disabled
  if (el.furtherAnalysisBtn) el.furtherAnalysisBtn.disabled = true;
  if (el.saveReportBtn) el.saveReportBtn.disabled = false;
}

function populateResult(pred, conf) {
  let displayText = pred || "Unknown";
  let displayClass = "";
  if (/bacterial/i.test(pred)) {
    displayText = "Pneumonia Positive (Bacterial)";
    displayClass = "result-positive";
  } else if (/viral/i.test(pred)) {
    displayText = "Pneumonia Positive (Viral)";
    displayClass = "result-positive";
  } else if (/normal/i.test(pred)) {
    displayText = "Pneumonia Negative";
    displayClass = "result-negative";
  }
  if (el.sliderResultValue) {
    el.sliderResultValue.textContent = displayText;
    el.sliderResultValue.className = `result-value ${displayClass}`;
  }
  if (el.sliderResultConfidence)
    el.sliderResultConfidence.textContent = `Confidence: ${Number(conf || 0).toFixed(1)}%`;
}

// Show "Analyzed X-Ray"
function showAnalyzedXRay(url, isNormalCase = false) {
  if (!url && isNormalCase) {
    // For Normal case, show the original image in the Analyzed X-Ray slot
    if (el.sliderHeatmapImg && el.xrayPreview?.src) {
      el.sliderHeatmapImg.src = el.xrayPreview.src;
      el.sliderHeatmapImg.style.display = "block";
      if (el.heatmapStatusText) el.heatmapStatusText.textContent = "";
    }
    return;
  }

  if (!url) {
    if (el.heatmapStatusText) {
      el.heatmapStatusText.innerHTML =
        '<i class="fas fa-exclamation-triangle"></i> Analyzed view unavailable.';
    }
    return;
  }

  if (el.sliderHeatmapImg) {
    el.sliderHeatmapImg.src = url;
    el.sliderHeatmapImg.onload = () => {
      if (el.heatmapStatusText) el.heatmapStatusText.textContent = "";
      el.sliderHeatmapImg.style.display = "block";
    };
    el.sliderHeatmapImg.onerror = () => {
      if (el.heatmapStatusText) {
        el.heatmapStatusText.innerHTML =
          '<i class="fas fa-exclamation-triangle"></i> Analyzed view failed to load.';
      }
    };
  }
}

// Show Comment
function showComment(txt) {
  if (el.clipCaptionText) {
    el.clipCaptionText.textContent = txt || "Comment not available.";
  }
}

/* =========================
   BACKEND CALLS
   ========================= */
async function analyzeInitial(file) {
  const fd = new FormData();
  fd.append("file", file);
  console.log("↗ POST /analyzeXray");
  const r = await fetch(`${API_BASE}/analyzeXray`, { method: "POST", body: fd });
  console.log("↙ /analyzeXray", r.status);
  if (!r.ok) throw new Error(`Server error: ${r.status}`);
  const d = await r.json();
  if (!d.success) throw new Error(d.error || "Analysis failed");
  return d;
}

async function analyzeFurther(file) {
  const fd = new FormData();
  fd.append("file", file);
  console.log("↗ POST /furtherAnalysis");
  const r = await fetch(`${API_BASE}/furtherAnalysis`, { method: "POST", body: fd });
  console.log("↙ /furtherAnalysis", r.status);
  if (!r.ok) throw new Error(`Server error: ${r.status}`);
  const d = await r.json();
  if (!d.success) throw new Error(d.error || "Further analysis failed");
  return d;
}

/* =========================
   ANALYSIS FLOW (Normal + Pneumonia)
   ========================= */
async function handleAnalyzeClick(ev) {
  ev?.preventDefault();
  if (!AnalysisState.validated || !AnalysisState.file) {
    showToast(" Please upload & validate a chest X-ray first", "error");
    return;
  }

  showAnalysisProgress();
  if (el.analyzeBtn) {
    el.analyzeBtn.innerHTML = '<i class="fas fa-spinner fa-spin"></i> Analyzing...';
    el.analyzeBtn.disabled = true;
  }
  openAnalysisSlider();
  initSliderLoadingState();

  try {
    // Phase-1: Detect pneumonia (and fetch initial result)
    let data;
    await runPhase(0, "Detecting pneumonia in X-ray...", async () => {
      data = await analyzeInitial(AnalysisState.file);
      const stage1 = data.analysis?.stage1 || data.stage1;
      const stage1Pred = stage1?.prediction || data?.stage1_prediction || "Unknown";
      const stage1Conf = stage1?.confidence || data?.stage1_confidence || 0;

      AnalysisState.stage1 = { prediction: stage1Pred, confidence: stage1Conf };
      AnalysisState.lastCaseType = /normal/i.test(stage1Pred) ? "Normal" : "Pneumonia";
      AnalysisState.isNormalCase = /normal/i.test(stage1Pred);
    });

    // Normal case: skip Phase-2 & Phase-3, run Phase-4 only
    if (AnalysisState.isNormalCase) {
      console.log(" Normal case detected - skipping Phase-2 & Phase-3");

      AnalysisState.commentText =
        "This chest X-ray appears normal with clear lungs and no signs of pneumonia.";

      await runPhase(3, "Generating Comment...", async () => {
        await sleep(1500);
      });

      AnalysisState.finalPrediction = AnalysisState.stage1.prediction;
      AnalysisState.finalConfidence = AnalysisState.stage1.confidence;
      populateResult(AnalysisState.finalPrediction, AnalysisState.finalConfidence);

      showAnalyzedXRay(null, true);
      showComment(AnalysisState.commentText);

      if (el.furtherAnalysisBtn) {
        el.furtherAnalysisBtn.style.display = "none";
        el.furtherAnalysisBtn.disabled = true;
      }
    } else {
      // Pneumonia case: run Phase-2 (type classification)
      await runPhase(1, "Detecting type of pneumonia...", async () => {
        const stage2 = data.analysis?.stage2 || data.stage2;
        const stage2Pred = stage2?.prediction || data?.stage2_prediction || "Pneumonia";
        const stage2Conf = stage2?.confidence || data?.stage2_confidence || 0;

        AnalysisState.stage2 = { prediction: stage2Pred, confidence: stage2Conf };
      });

      AnalysisState.finalPrediction = AnalysisState.stage2.prediction;
      AnalysisState.finalConfidence = AnalysisState.stage2.confidence;
      populateResult(AnalysisState.finalPrediction, AnalysisState.finalConfidence);

      AnalysisState.commentText =
        "This chest X-ray shows abnormalities suggesting pneumonia. Run Further Analysis for detailed visualization.";
      showComment(AnalysisState.commentText);

      if (el.heatmapStatusText) {
        el.heatmapStatusText.innerHTML =
          '<i class="fas fa-info-circle"></i> Analyzed view unavailable. Use <strong>Further Analysis</strong> to generate analyzed view & detailed comment.';
      }

      if (el.furtherAnalysisBtn) {
        el.furtherAnalysisBtn.style.display = "inline-flex";
        el.furtherAnalysisBtn.disabled = false;
      }
    }

    AnalysisState.initialDone = true;
    hideContainer();

    // Quick result popup for both Normal and Pneumonia
    try {
      const resType = String(AnalysisState.finalPrediction || "—");
      const conf = Number(AnalysisState.finalConfidence || 0);

      let popupMessage = "";
      if (AnalysisState.isNormalCase) {
        popupMessage = " Normal detected — No pneumonia found.";
      } else {
        if (resType.includes("Bacterial")) {
          popupMessage =
            " Bacterial Pneumonia detected — Antibiotic treatment recommended.";
        } else if (resType.includes("Viral")) {
          popupMessage =
            " Viral Pneumonia detected — Supportive care and monitoring advised.";
        } else {
          popupMessage = " Pneumonia detected — Further analysis recommended.";
        }
      }

      setTimeout(() => {
        showResultAnnouncement(resType, conf, popupMessage);
      }, 400);

      setTimeout(() => {
        hideResultAnnouncement();
      }, 2200);
    } catch (e) {
      console.warn("Announcement popup error:", e);
    }
  } catch (err) {
    console.error("Analysis error:", err);
    showToast(" Analysis failed: " + err.message, "error");
    errorAllPhases("Analysis failed");
  } finally {
    if (el.analyzeBtn) {
      el.analyzeBtn.innerHTML = "Analyze X-Ray";
      el.analyzeBtn.disabled = false;
    }
  }
}

async function handleFurtherAnalysisClick(e) {
  e?.preventDefault();

  if (AnalysisState.isNormalCase) {
    showToast("Further Analysis not available for Normal cases", "info");
    return;
  }

  if (!AnalysisState.initialDone || !AnalysisState.file) {
    showToast("Run initial analysis first.", "error");
    return;
  }

  showAnalysisProgress();

  try {
    await runPhase(2, "Generating Analyzed X-Ray...", async () => {
      const d = await analyzeFurther(AnalysisState.file);
      AnalysisState.heatmapUrl = d.heatmap || d.gradcam || d.gradcam_url || null;
      showAnalyzedXRay(AnalysisState.heatmapUrl, false);

      AnalysisState.finalPrediction =
        d.final_prediction ||
        AnalysisState.finalPrediction ||
        (AnalysisState.stage2?.prediction || AnalysisState.stage1?.prediction);

      AnalysisState.finalConfidence =
        d.final_confidence ||
        AnalysisState.finalConfidence ||
        (AnalysisState.stage2?.confidence || AnalysisState.stage1?.confidence);

      populateResult(AnalysisState.finalPrediction, AnalysisState.finalConfidence);

      AnalysisState.commentText =
        d.comment?.text ||
        d.comment ||
        "Detailed analysis complete. Review the heatmap for affected areas.";
    });

    await runPhase(3, "Generating Comment...", async () => {
      showComment(AnalysisState.commentText || "Comment not available.");
    });

    AnalysisState.furtherDone = true;
    hideContainer();

    setTimeout(() => {
      showToast(
        " Further analysis complete! Heatmap and detailed comment generated.",
        "success"
      );
    }, 500);
  } catch (err) {
    console.error("Further analysis error:", err);
    showToast(" Further analysis failed: " + err.message, "error");
    errorAllPhases("Further analysis failed");
  }
}

/* =========================
   SAVE REPORT (Hierarchical structure)
   ========================= */
async function saveReport(e) {
  e?.preventDefault();

  if (!AnalysisState.initialDone) {
    showToast("Please run initial analysis before saving.", "error");
    return;
  }

  const name = el.patientName?.value?.trim();
  const age = el.patientAge?.value?.trim();
  const gender = el.patientGender?.value?.trim() || "";
  if (!name || !age) {
    showToast("Patient name and age are required", "error");
    return;
  }

  let analyzedXRayUrl = null;
  if (AnalysisState.isNormalCase) {
    analyzedXRayUrl = el.xrayPreview?.src || null;
  } else {
    analyzedXRayUrl = AnalysisState.heatmapUrl || null;
  }

  const payload = {
    name,
    age,
    gender,
    notes: gender,
    result: AnalysisState.finalPrediction || "Unknown",
    confidence: AnalysisState.finalConfidence || 0,
    date: new Date(),
    radiologistId: currentUser.uid,
    radiologistName: userData?.name || "Dr. Radiologist",
    originalImageUrl: el.xrayPreview?.src || null,
    heatmapUrl: analyzedXRayUrl,
    caption: AnalysisState.commentText || null,
  };

  if (el.saveReportBtn) {
    el.saveReportBtn.disabled = true;
    el.saveReportBtn.innerHTML = '<i class="fas fa-spinner fa-spin"></i> Saving...';
  }

  try {
    // Use nested reports collection
    const ref = await reportsCollectionForUser(currentUser.uid).add(payload);
    const fullId = ref.id;
    const pretty = "R-" + fullId.slice(-8);
    await ref.update({ reportId: fullId, reportIdShort: pretty });

    showToast(" Report saved successfully", "success");

    resetXrayUI(false);
    el.patientForm?.reset();
    closeAnalysisSliderUI();
    showPage("upload");
  } catch (e2) {
    console.error(e2);
    showToast(" Failed to save report", "error");
  } finally {
    if (el.saveReportBtn) {
      el.saveReportBtn.innerHTML = '<i class="fas fa-save"></i> Save Report';
      el.saveReportBtn.disabled = false;
    }
  }
}

/* =========================
   HISTORY (Nested reports)
   ========================= */
async function loadHistory() {
  if (!el.historyTableBody || !currentUser) return;

  el.historyTableBody.innerHTML =
    '<tr><td colspan="7" style="text-align:center;padding:2rem"><i class="fas fa-spinner fa-spin"></i> Loading history...</td></tr>';

  try {
    // Ensure legacy reports are migrated for this user
    await migrateLegacyReportsForCurrentUser(currentUser);

    const q = await reportsCollectionForUser(currentUser.uid)
      .orderBy("date", "desc")
      .get();

    if (q.empty) {
      ALL_REPORTS = [];
      el.historyTableBody.innerHTML =
        '<tr><td colspan="7" style="text-align:center;padding:2rem">No reports found</td></tr>';
      return;
    }

    ALL_REPORTS = q.docs.map((doc) => {
      const r = doc.data();
      const displayResult = /bacterial/i.test(r.result)
        ? "Pneumonia Positive (Bacterial)"
        : /viral/i.test(r.result)
        ? "Pneumonia Positive (Viral)"
        : /normal/i.test(r.result)
        ? "Pneumonia Negative"
        : r.result || "—";
      return {
        id: doc.id,
        reportId: r.reportId || doc.id,
        reportIdShort: r.reportIdShort || "R-" + (doc.id || "").slice(-8),
        name: r.name || "N/A",
        age: r.age || "N/A",
        gender: r.gender || r.notes || "—",
        resultRaw: r.result || "—",
        resultDisplay: displayResult,
        confidence: r.confidence ?? "N/A",
      };
    });

    renderHistory(ALL_REPORTS);
  } catch (e) {
    console.error(e);
    el.historyTableBody.innerHTML =
      '<tr><td colspan="7" style="text-align:center;padding:2rem;color:var(--danger)">Error loading history</td></tr>';
  }
}

function renderHistory(rows) {
  if (!el.historyTableBody) return;
  if (!rows || rows.length === 0) {
    el.historyTableBody.innerHTML =
      '<tr><td colspan="7" style="text-align:center;padding:2rem">No matching records</td></tr>';
    return;
  }

  el.historyTableBody.innerHTML = "";
  rows.forEach((r) => {
    const tr = document.createElement("tr");
    const posClass = /Positive/.test(r.resultDisplay) ? "result-positive" : "result-negative";

    tr.innerHTML = `
      <td>${r.name}</td>
      <td>${r.age}</td>
      <td>${r.gender}</td>
      <td class="${posClass}">${r.resultDisplay}</td>
      <td>${
        r.confidence !== "N/A" ? Number(r.confidence).toFixed(2) + "%" : "N/A"
      }</td>

      <td>
        <div style="display:flex; align-items:center; gap:8px;">
          <span class="id-badge" title="${r.reportId}"
                style="background:#eef3ff; color:#1a73e8; padding:4px 8px; border-radius:8px; font-weight:600;">
            ${r.reportIdShort}
          </span>
          <button class="btn-icon copy-id" data-fullid="${r.reportId}" title="Copy full ID">
            <i class="fas fa-copy"></i>
          </button>
        </div>
      </td>

      <td class="table-actions">
        <button class="btn btn-secondary btn-sm" onclick="downloadReport('${r.id}', this)" title="Download PDF">
          <i class="fas fa-download"></i>
        </button>
        <button class="btn btn-danger btn-sm" onclick="removeReport('${r.id}')" title="Delete">
          <i class="fas fa-trash"></i>
        </button>
      </td>`;

    el.historyTableBody.appendChild(tr);
  });

  el.historyTableBody.querySelectorAll(".copy-id").forEach((btn) => {
    btn.addEventListener("click", () => {
      const id = btn.getAttribute("data-fullid");
      if (id && navigator.clipboard) navigator.clipboard.writeText(id);
      showToast("Report ID copied", "success");
    });
  });
}

// Search
function normalize(x) {
  return x == null ? "" : String(x).toLowerCase().trim();
}
function debounce(fn, ms = 200) {
  let t;
  return (...a) => {
    clearTimeout(t);
    t = setTimeout(() => fn(...a), ms);
  };
}
const runHistoryFilter = debounce(() => {
  if (!el.historySearch) {
    renderHistory(ALL_REPORTS);
    return;
  }
  const q = normalize(el.historySearch.value);
  if (!q) {
    renderHistory(ALL_REPORTS);
    return;
  }

  const filtered = ALL_REPORTS.filter((r) => {
    const fields = [
      r.name,
      r.age,
      r.gender,
      r.resultDisplay,
      r.resultRaw,
      r.confidence !== "N/A" ? Number(r.confidence).toFixed(2) : "",
      r.reportId,
      r.reportIdShort,
    ];
    return fields.some((f) => normalize(f).includes(q));
  });

  renderHistory(filtered);
}, 150);

function removeReport(id) {
  if (!confirm("Are you sure you want to delete this report?")) return;
  reportsCollectionForUser(currentUser.uid)
    .doc(id)
    .delete()
    .then(() => {
      showToast("Report deleted", "success");
      loadHistory();
    })
    .catch((e) => {
      console.error(e);
      showToast("Delete failed", "error");
    });
}

/* =========================
   PDF GENERATION (Nested report path)
   ========================= */
async function loadImageAsBase64(url) {
  return new Promise((resolve) => {
    try {
      const img = new Image();
      img.crossOrigin = "anonymous";
      img.onload = () => {
        const c = document.createElement("canvas");
        c.width = img.width;
        c.height = img.height;
        c.getContext("2d").drawImage(img, 0, 0);
        resolve(c.toDataURL("image/jpeg", 0.8));
      };
      img.onerror = () => resolve(null);
      img.src = url;
    } catch (_) {
      resolve(null);
    }
  });
}

async function downloadReport(reportId, btn) {
  if (!btn) return;
  try {
    btn.innerHTML = '<i class="fas fa-spinner fa-spin"></i>';
    btn.disabled = true;

    const snap = await reportsCollectionForUser(currentUser.uid).doc(reportId).get();
    if (!snap.exists) {
      showToast("Report not found", "error");
      return;
    }

    const r = snap.data();
    const reportIdText = r.reportIdShort || r.reportId || snap.id;
    const { jsPDF } = window.jspdf;
    const doc = new jsPDF("p", "mm", "a4");
    const W = doc.internal.pageSize.getWidth();
    const H = doc.internal.pageSize.getHeight();
    const M = 15;

    const BLUE = { r: 14, g: 78, b: 144 };
    const LGRAY = { r: 230, g: 236, b: 245 };
    const TGRAY = { r: 100, g: 100, b: 100 };

    const doctor = userData?.name || r.radiologistName || "Radiologist";
    const hosp = userData?.institution || r.hospital || "—";
    const email = currentUser?.email || "—";

    let y;
    function sectionHeader(label, barH = 7, gap = 7) {
      doc.setFillColor(LGRAY.r, LGRAY.g, LGRAY.b);
      doc.rect(M, y, W - 2 * M, barH, "F");
      doc.setFont("helvetica", "bold");
      doc.setTextColor(0, 0, 0);
      doc.setFontSize(11.5);
      doc.text(label, M + 2.5, y + barH - 2);
      y += gap + 2;
    }
    const rowHHeader = 8,
      rowHBody = 8;
    function headerCell(x, w, text) {
      doc.setFillColor(LGRAY.r, LGRAY.g, LGRAY.b);
      doc.rect(x, y, w, rowHHeader, "F");
      doc.setDrawColor(0, 0, 0);
      doc.rect(x, y, w, rowHHeader);
      doc.setFont("helvetica", "bold");
      doc.setFontSize(10.5);
      doc.setTextColor(0, 0, 0);
      doc.text(text, x + 2.5, y + 5.2);
    }
    function bodyCell(x, w, text) {
      doc.setDrawColor(0, 0, 0);
      doc.rect(x, y, w, rowHBody);
      doc.setFont("helvetica", "normal");
      doc.setFontSize(10.5);
      doc.setTextColor(0, 0, 0);
      doc.text(String(text ?? "—"), x + 2.5, y + 5.2);
    }

    // Top bar
    doc.setFillColor(BLUE.r, BLUE.g, BLUE.b);
    const topBarH = 12;
    doc.rect(M, 14, W - 2 * M, topBarH, "F");
    doc.setTextColor(255, 255, 255);
    doc.setFont("helvetica", "bold");
    doc.setFontSize(15);
    doc.text(String(hosp), W / 2, 14 + topBarH / 2 + 4, { align: "center" });

    // Title
    const titleY = 14 + topBarH + 8;
    const pillH = 9;
    doc.setFillColor(LGRAY.r, LGRAY.g, LGRAY.b);
    if (doc.roundedRect)
      doc.roundedRect(W / 2 - 45, titleY - pillH + 1, 90, pillH, 2, 2, "F");
    else doc.rect(W / 2 - 45, titleY - pillH + 1, 90, pillH, "F");
    doc.setTextColor(0, 0, 0);
    doc.setFont("helvetica", "bold");
    doc.setFontSize(12);
    doc.text("CHEST X-RAY DIAGNOSTIC REPORT", W / 2, titleY - 2, { align: "center" });

    // Meta row
    y = titleY + 8;
    const bandH = 14;
    doc.setFillColor(LGRAY.r, LGRAY.g, LGRAY.b);
    doc.rect(M, y, W - 2 * M, bandH, "F");

    const halfW = (W - 2 * M) / 2;
    const boxY = y + 2;
    const boxH = bandH - 4;
    const leftX = M + 2;
    const rightX = M + halfW + 2;

    doc.setDrawColor(0, 0, 0);
    doc.setLineWidth(0.25);
    doc.setFillColor(255, 255, 255);
    doc.rect(leftX, boxY, halfW - 4, boxH, "FD");
    doc.rect(rightX, boxY, halfW - 4, boxH, "FD");

    doc.setFontSize(11.5);
    doc.setFont("helvetica", "bold");
    doc.setTextColor(0, 0, 0);
    doc.text("Report ID:", leftX + 2.5, boxY + boxH / 2 + 1.5);
    doc.setFont("helvetica", "normal");
    doc.text(String(reportIdText), leftX + 25, boxY + boxH / 2 + 1.5);

    doc.setFont("helvetica", "bold");
    doc.text("Date:", rightX + 2.5, boxY + boxH / 2 + 1.5);
    doc.setFont("helvetica", "normal");
    doc.text(new Date().toLocaleDateString(), rightX + 18, boxY + boxH / 2 + 1.5);

    y += bandH + 6;

    // Attending radiologist
    sectionHeader("Attending Radiologist");
    const gridW = W - 2 * M,
      colW = gridW / 3;
    const x1 = M,
      x2 = M + colW,
      x3 = M + 2 * colW;

    headerCell(x1, colW, "Name");
    headerCell(x2, colW, "Hospital");
    headerCell(x3, colW, "Email");
    y += rowHHeader;

    bodyCell(x1, colW, `Dr. ${doctor}`);
    bodyCell(x2, colW, hosp);
    bodyCell(x3, colW, email);
    y += rowHBody + 5;

    // Patient info
    sectionHeader("Patient Information");
    headerCell(x1, colW, "Name");
    headerCell(x2, colW, "Age");
    headerCell(x3, colW, "Gender");
    y += rowHHeader;

    bodyCell(x1, colW, r.name || "—");
    bodyCell(x2, colW, r.age || "—");
    bodyCell(x3, colW, r.gender || r.notes || "—");
    y += rowHBody + 5;

    // Diagnostic results
    sectionHeader("Diagnostic Results");
    y += 3;

    doc.setFont("helvetica", "bold");
    doc.setFontSize(11);
    const lineGap = 7;

    doc.text("Diagnosis :", M, y);
    doc.setFont("helvetica", "normal");
    doc.text(String(r.result || "—"), M + 25, y);

    y += lineGap;
    doc.setFont("helvetica", "bold");
    doc.text("Confidence :", M, y);
    doc.setFont("helvetica", "normal");
    const confidenceValue = r.confidence ?? "0";
    const formattedConfidence = Number(confidenceValue).toFixed(
      confidenceValue % 1 === 0 ? 0 : 1
    );
    doc.text(`${formattedConfidence}%`, M + 25, y);

    y += 8;

    // Comment section
    sectionHeader("Comment");
    doc.setFont("helvetica", "bold");
    doc.setFontSize(10.8);
    const commentText = r.caption || "—";
    const wrapped = doc.splitTextToSize(commentText, W - 2 * M);
    y += 3;
    doc.text(wrapped, M, y);
    y += wrapped.length * 5 + 6;

    // Medical images
    sectionHeader("Medical Images");

    const imgW = 82,
      imgH = 90,
      gap = 18;
    const ix1 = M,
      ix2 = M + imgW + gap;

    doc.setDrawColor(0, 0, 0);
    doc.setLineWidth(0.6);

    // Original X-ray
    if (r.originalImageUrl) {
      const b64 = await loadImageAsBase64(r.originalImageUrl);
      if (b64) {
        if (doc.roundedRect) doc.roundedRect(ix1, y, imgW, imgH, 3, 3);
        else doc.rect(ix1, y, imgW, imgH);
        doc.addImage(b64, "JPEG", ix1 + 1.5, y + 1.5, imgW - 3, imgH - 3);
        doc.setFont("helvetica", "normal");
        doc.setFontSize(10);
        doc.text("Original Chest X-ray", ix1 + imgW / 2, y + imgH + 6, {
          align: "center",
        });
      }
    }

    // Analyzed X-Ray (Normal = original, Pneumonia = heatmap)
    if (r.heatmapUrl) {
      const b64h = await loadImageAsBase64(r.heatmapUrl);
      if (b64h) {
        if (doc.roundedRect) doc.roundedRect(ix2, y, imgW, imgH, 3, 3);
        else doc.rect(ix2, y, imgW, imgH);
        doc.addImage(b64h, "JPEG", ix2 + 1.5, y + 1.5, imgW - 3, imgH - 3);
        doc.setFont("helvetica", "normal");
        doc.setFontSize(10);
        doc.text("Analyzed X-Ray", ix2 + imgW / 2, y + imgH + 6, {
          align: "center",
        });
      }
    }

    y += imgH + 10;

    // Footer
    doc.setLineWidth(0.3);
    doc.setDrawColor(0, 0, 0);
    doc.line(M, y, W - M, y);

    doc.setFont("helvetica", "italic");
    doc.setFontSize(9);
    doc.setTextColor(TGRAY.r, TGRAY.g, TGRAY.b);
    doc.text(
      "Generated by PneumoScan AI Diagnostic System",
      W / 2,
      y + 7,
      { align: "center" }
    );

    doc.save(`PneumoScan_Report_${r.name || "Patient"}.pdf`);
    showToast(" PDF downloaded successfully", "success");
  } catch (e) {
    console.error(e);
    showToast(" PDF generation failed", "error");
  } finally {
    btn.innerHTML = '<i class="fas fa-download"></i>';
    btn.disabled = false;
  }
}

/* =========================
   SETTINGS / AUTH (Notifications) - ENHANCED
   ========================= */
function loadNotificationSettings() {
  const s = localStorage.getItem("notificationSettings");
  if (s) notificationSettings = JSON.parse(s);
  if (el.pushNotifications) el.pushNotifications.checked = notificationSettings.push;
}
function saveNotificationSettings() {
  localStorage.setItem("notificationSettings", JSON.stringify(notificationSettings));
}

function signOut() {
  auth
    .signOut()
    .then(() => {
      localStorage.removeItem(RADIOLOGIST_SESSION_KEY);
      localStorage.removeItem("currentUser");
      window.location.href = "index.html";
    })
    .catch((e) => {
      console.error(e);
      showToast("Error signing out", "error");
    });
}

/* =========================
   MODAL HANDLERS
   ========================= */
function openChangePasswordModal() {
  if (!el.changePasswordModal) return;
  el.changePasswordModal.style.display = "flex";
  el.changePasswordForm?.reset();
}
function closeChangePasswordModal() {
  if (!el.changePasswordModal) return;
  el.changePasswordModal.style.display = "none";
  el.changePasswordForm?.reset();
}

async function handleChangePassword(e) {
  e.preventDefault();
  const curr = el.currentPassword.value;
  const np = el.newPassword.value;
  const cp = el.confirmPassword.value;
  if (!curr || !np || !cp) {
    showToast("Please fill all fields", "error");
    return;
  }
  if (np !== cp) {
    showToast("New passwords do not match", "error");
    return;
  }
  try {
    const user = auth.currentUser;
    const cred = firebase.auth.EmailAuthProvider.credential(
      user.email,
      curr
    );
    await user.reauthenticateWithCredential(cred);
    await user.updatePassword(np);
    showToast(" Password changed successfully", "success");
    closeChangePasswordModal();
  } catch (err) {
    console.error(err);
    showToast(" Error changing password", "error");
  }
}

function openDeleteAccountModal() {
  if (!el.deleteAccountModal) return;
  el.deleteAccountModal.style.display = "flex";
  el.deleteAccountForm?.reset();
}
function closeDeleteAccountModal() {
  if (!el.deleteAccountModal) return;
  el.deleteAccountModal.style.display = "none";
  el.deleteAccountForm?.reset();
}

/**
 * Delete account (Auth user + new-structure docs + legacy cleanup)
 * With visual animation on the delete button.
 */
async function handleDeleteAccount(e) {
  e.preventDefault();
  const pw = el.deletePassword.value;
  if (!pw) {
    showToast("Please enter your password", "error");
    return;
  }

  const submitBtn =
    el.deleteAccountForm &&
    el.deleteAccountForm.querySelector('button[type="submit"]');
  const originalText = submitBtn ? submitBtn.innerHTML : null;

  try {
    if (submitBtn) {
      submitBtn.disabled = true;
      submitBtn.innerHTML =
        '<i class="fas fa-spinner fa-spin"></i> Deleting account...';
    }

    const user = auth.currentUser;
    const cred = firebase.auth.EmailAuthProvider.credential(
      user.email,
      pw
    );
    await user.reauthenticateWithCredential(cred);

    const uid = user.uid;
    const radiologistEmail = user.email;
    const radiologistName = userData?.name || user.displayName || "Radiologist";

    // Delete nested reports
    const nestedSnap = await reportsCollectionForUser(uid).get();
    const deletions = [];
    nestedSnap.forEach((doc) => deletions.push(doc.ref.delete()));

    // Also delete legacy top-level reports for safety
    const legacySnap = await legacyReportsCollection
      .where("radiologistId", "==", uid)
      .get();
    legacySnap.forEach((doc) => deletions.push(doc.ref.delete()));

    await Promise.all(deletions);

    // Delete radiologist doc in new hierarchy
    await radiologistsCollection().doc(uid).delete().catch(() => {});
    // Delete legacy radiologist doc if exists
    await legacyRadiologistsCollection.doc(uid).delete().catch(() => {});

    // Trigger email after Firestore cleanup but before deleting Auth user
    try {
      const adminEmails = [];

      const adminsSnap = await radiologistsCollection()
        .where("role", "==", "admin")
        .where("approved", "==", true)
        .get();

      adminsSnap.forEach((doc) => {
        const d = doc.data() || {};
        if (d.email) adminEmails.push(d.email);
      });

      await fetch("http://localhost:4000/email/radiologist-deleted", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          radiologistEmail,
          radiologistName,
          adminEmails,
        }),
      });
    } catch (err) {
      console.error("radiologist delete email error:", err);
    }

    // Finally delete Auth user
    await user.delete();

    // Nice visual feedback
    showToast(" Account deleted successfully", "success");
    closeDeleteAccountModal();

    setTimeout(() => (window.location.href = "index.html"), 1200);
  } catch (err) {
    console.error(err);
    showToast(" Account deletion failed", "error");
    if (submitBtn && originalText) {
      submitBtn.innerHTML = originalText;
      submitBtn.disabled = false;
    }
  }
}


/* =========================
   RESET UI
   ========================= */
function resetXrayUI(keepPreview = false) {
  if (el.xrayPreview && !keepPreview) {
    el.xrayPreview.src = "";
    el.xrayPreview.style.display = "none";
  }
  el.xrayUpload.innerHTML =
    '<i class="fas fa-cloud-upload-alt"></i> Drag & Drop X-Ray Image or Click to Browse';
  if (el.analyzeBtn) {
    el.analyzeBtn.style.display = "inline-flex";
    el.analyzeBtn.disabled = true;
    el.analyzeBtn.title = "Upload a valid chest X-ray first";
  }
  if (el.furtherAnalysisBtn) {
    el.furtherAnalysisBtn.disabled = true;
    el.furtherAnalysisBtn.style.display = "inline-flex";
  }
  if (el.saveReportBtn) el.saveReportBtn.disabled = true;
  if (el.xrayFile) el.xrayFile.value = "";
  closeAnalysisSliderUI();
  resetAnalysisState();
}

/* =========================
   RESULT ANNOUNCEMENT
   ========================= */
function showResultAnnouncement(resultType, confidence, message) {
  if (!el.resultAnnouncementModal) return;

  if (el.announcementIcon) {
    el.announcementIcon.className = "announcement-icon";
    const low = (resultType || "").toLowerCase();
    if (low.includes("normal")) {
      el.announcementIcon.classList.add("normal");
      el.announcementIcon.innerHTML = '<i class="fas fa-check-circle"></i>';
    } else if (low.includes("bacterial")) {
      el.announcementIcon.classList.add("bacterial");
      el.announcementIcon.innerHTML = '<i class="fas fa-bacteria"></i>';
    } else if (low.includes("viral")) {
      el.announcementIcon.classList.add("viral");
      el.announcementIcon.innerHTML = '<i class="fas fa-virus"></i>';
    } else {
      el.announcementIcon.classList.add("normal");
      el.announcementIcon.innerHTML = '<i class="fas fa-stethoscope"></i>';
    }
  }

  if (el.announcementTitle) el.announcementTitle.textContent = "Analysis Complete";
  if (el.resultType) {
    el.resultType.textContent = resultType || "—";
    el.resultType.className = "result-type";
    const low = (resultType || "").toLowerCase();
    if (low.includes("normal")) el.resultType.classList.add("normal");
    else if (low.includes("bacterial")) el.resultType.classList.add("bacterial");
    else if (low.includes("viral")) el.resultType.classList.add("viral");
  }
  if (el.resultConfidence)
    el.resultConfidence.textContent = `Confidence: ${Number(confidence || 0).toFixed(1)}%`;
  if (el.announcementMessage) el.announcementMessage.textContent = message || "—";

  el.resultAnnouncementModal.style.display = "block";
}
function hideResultAnnouncement() {
  if (el.resultAnnouncementModal) el.resultAnnouncementModal.style.display = "none";
}

/* =========================
   EVENT LISTENERS
   ========================= */
function setupEventListeners() {
  // Prevent form submit (Enter)
  el.patientForm?.addEventListener("submit", (e) => {
    e.preventDefault();
    e.stopPropagation();
  });
  el.patientForm?.addEventListener("keydown", (e) => {
    if (e.key === "Enter") e.preventDefault();
  });

  // Patient inputs -> stacked display live
  ["input", "change"].forEach((evt) => {
    el.patientName?.addEventListener(evt, () => {
      if (el.sliderPatientName)
        el.sliderPatientName.textContent = el.patientName.value.trim() || "—";
    });
    el.patientAge?.addEventListener(evt, () => {
      if (el.sliderPatientAge)
        el.sliderPatientAge.textContent = el.patientAge.value.trim() || "—";
    });
    el.patientGender?.addEventListener(evt, () => {
      if (el.sliderPatientGender)
        el.sliderPatientGender.textContent = el.patientGender.value.trim() || "—";
    });
  });

  // User menu / theme
  el.userAvatar?.addEventListener("click", () =>
    el.dropdownMenu.classList.toggle("show")
  );
  el.logoutBtn?.addEventListener("click", (e) => {
    e.preventDefault();
    signOut();
  });
  el.themeToggle?.addEventListener("click", (e) => {
    e.preventDefault();
    toggleTheme();
  });
  el.darkModeToggle?.addEventListener("click", toggleTheme);

  // Notifications (Push only)
  el.pushNotifications?.addEventListener("change", function () {
    notificationSettings.push = this.checked;
    saveNotificationSettings();
    if (this.checked && "Notification" in window && Notification.permission === "default") {
      Notification.requestPermission();
    }
    showToast(
      `Push notifications ${this.checked ? "enabled" : "disabled"}`,
      "success"
    );
  });

  // Navigation
  el.navLinks.forEach((a) =>
    a.addEventListener("click", function (e) {
      e.preventDefault();
      showPage(this.dataset.page);
    })
  );
  el.sidebarLinks.forEach((a) =>
    a.addEventListener("click", function (e) {
      e.preventDefault();
      showPage(this.dataset.page);
    })
  );
  document.querySelectorAll(".dropdown-item[data-page]").forEach((i) =>
    i.addEventListener("click", function (e) {
      e.preventDefault();
      showPage(this.dataset.page);
    })
  );

  // Profile editing
  $id("editProfileBtn")?.addEventListener("click", enableProfileEditing);
  $id("cancelEditBtn")?.addEventListener("click", disableProfileEditing);
  $id("saveProfileBtn")?.addEventListener("click", saveProfileChanges);

  // X-ray upload and analysis
  el.xrayUpload?.addEventListener("click", () => el.xrayFile?.click());
  el.xrayFile?.addEventListener("change", handleXrayUpload);
  el.analyzeBtn?.addEventListener("click", handleAnalyzeClick);
  el.furtherAnalysisBtn?.addEventListener("click", handleFurtherAnalysisClick);
  el.saveReportBtn?.addEventListener("click", saveReport);

  // Analysis slider close
  el.closeAnalysisSlider?.addEventListener("click", closeAnalysisSliderUI);

  // Result announcement modal
  el.closeAnnouncementBtn?.addEventListener("click", hideResultAnnouncement);

  // Modals
  el.changePasswordForm?.addEventListener("submit", handleChangePassword);
  el.deleteAccountForm?.addEventListener("submit", handleDeleteAccount);

  // Close icons (X) for modals
  el.closePasswordModal?.addEventListener("click", (e) => {
    e.preventDefault();
    closeChangePasswordModal();
  });
  el.closeDeleteModal?.addEventListener("click", (e) => {
    e.preventDefault();
    closeDeleteAccountModal();
  });

  // Close menu on outside click
  document.addEventListener("click", (e) => {
    if (!e.target.closest(".user-menu"))
      el.dropdownMenu?.classList.remove("show");
  });

  // History search input
  if (el.historySearch) {
    el.historySearch.addEventListener("input", runHistoryFilter);
  }
}

/* =========================
   GLOBAL EXPORTS
   ========================= */
window.downloadReport = downloadReport;
window.removeReport = removeReport;
window.openChangePasswordModal = openChangePasswordModal;
window.openDeleteAccountModal = openDeleteAccountModal;
window.closeDeleteAccountModal = closeDeleteAccountModal;
window.enableProfileEditing = enableProfileEditing;
window.disableProfileEditing = disableProfileEditing;
window.saveProfileChanges = saveProfileChanges;

/* =========================
   Helpers for overlay errors
   ========================= */
function errorAllPhases(msg = "Analysis failed") {
  PHASES.forEach((p) => {
    const e = p.el(),
      t = p.text(),
      g = p.prog();
    if (e) e.className = "analysis-phase error";
    if (t) t.textContent = msg;
    if (g) g.style.width = "100%";
    if (e) e.style.display = "block";
  });
}
function showAnalysisProgress() {
  resetAllPhases();
  showContainer();
}

/* =========================
   Session management for multi-tab support
   ========================= */

// Listen for storage events (for multi-tab session handling)
window.addEventListener('storage', (event) => {
  if (event.key === RADIOLOGIST_SESSION_KEY) {
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

// Clear session on page unload (optional)
window.addEventListener('beforeunload', () => {
  // Optional: Clear session if needed
  // localStorage.removeItem(RADIOLOGIST_SESSION_KEY);
});