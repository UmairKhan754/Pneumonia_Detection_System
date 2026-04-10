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

firebase.initializeApp(firebaseConfig);
const auth = firebase.auth();
const db = firebase.firestore();

// Email server (Node + Nodemailer)
const EMAIL_SERVER_BASE_URL = "http://localhost:4000"; 

// -------------------------------
// Firestore path helpers 
// -------------------------------
const ROOT_COLLECTION = "PneumoniaDetectionSystem";
const ROOT_ADMIN_DOC = "Root";

function radiologistsCollection() {
  return db
    .collection(ROOT_COLLECTION)
    .doc(ROOT_ADMIN_DOC)
    .collection("radiologists & admin");
}

// Legacy (old) collection name for backward compatibility
const legacyRadiologistsCollection = db.collection("radiologists & admin");

// Helper: find radiologist/admin by email 
async function findRadiologistByEmail(email) {
  // 1) Try new hierarchical path
  let snap = await radiologistsCollection()
    .where("email", "==", email)
    .limit(1)
    .get();
  if (!snap.empty) {
    return { doc: snap.docs[0], from: "hierarchy" };
  }

  // 2) Fallback: legacy top-level collection
  snap = await legacyRadiologistsCollection
    .where("email", "==", email)
    .limit(1)
    .get();
  if (!snap.empty) {
    return { doc: snap.docs[0], from: "legacy" };
  }

  return null;
}

// Helper: find ADMIN by email (for admin login)
async function findAdminByEmail(email) {
  // 1) New hierarchical path
  let snap = await radiologistsCollection()
    .where("email", "==", email)
    .where("role", "==", "admin")
    .limit(1)
    .get();

  if (!snap.empty) {
    return { doc: snap.docs[0], from: "hierarchy" };
  }

  // 2) Legacy top-level
  snap = await legacyRadiologistsCollection
    .where("email", "==", email)
    .where("role", "==", "admin")
    .limit(1)
    .get();

  if (!snap.empty) {
    return { doc: snap.docs[0], from: "legacy" };
  }

  return null;
}

// Helper: get radiologist doc by UID (with auto-migration from legacy → hierarchy)
async function getRadiologistDocByUid(uid) {
  const newRef = radiologistsCollection().doc(uid);
  const newSnap = await newRef.get();

  if (newSnap.exists) {
    return { doc: newSnap, from: "hierarchy" };
  }

  // Try legacy
  const legacyRef = legacyRadiologistsCollection.doc(uid);
  const legacySnap = await legacyRef.get();

  if (!legacySnap.exists) {
    return null;
  }

  // Auto-migrate legacy → new structure
  const legacyData = legacySnap.data() || {};
  const migratedPayload = {
    ...legacyData,
    migratedFrom: "radiologists_top_level",
    migratedAt: firebase.firestore.FieldValue.serverTimestamp(),
  };

  await newRef.set(migratedPayload, { merge: true });
  const finalSnap = await newRef.get();
  return { doc: finalSnap, from: "migratedLegacy" };
}

// -------------------------------
// Toast Notifications
// -------------------------------
function showToast(message, type = "error") {
  const container =
    document.getElementById("toastContainer") ||
    (() => {
      const c = document.createElement("div");
      c.id = "toastContainer";
      c.className = "toast-container";
      c.setAttribute("aria-live", "polite");
      c.setAttribute("aria-atomic", "true");
      document.body.appendChild(c);
      return c;
    })();

  const toast = document.createElement("div");
  toast.className = `toast ${type}`;
  toast.innerHTML = `
    ${message}
    <span class="close-btn" onclick="this.parentElement.remove()">×</span>
  `;
  container.appendChild(toast);

  setTimeout(() => toast.classList.add("show"), 50);
  setTimeout(() => {
    toast.classList.remove("show");
    setTimeout(() => toast.remove(), 350);
  }, 3000);
}

// -------------------------------
// Helpers: errors, validators, loading, overlays
// -------------------------------
function showError(errorId, message) {
  const errorElement = document.getElementById(errorId);
  const inputElement = document.getElementById(errorId.replace("-error", ""));
  if (errorElement) {
    errorElement.textContent = message;
    errorElement.style.display = "block";
  }
  if (inputElement) inputElement.classList.add("input-error");
}

function hideError(errorId) {
  const errorElement = document.getElementById(errorId);
  const inputElement = document.getElementById(errorId.replace("-error", ""));
  if (errorElement) errorElement.style.display = "none";
  if (inputElement) inputElement.classList.remove("input-error");
}

// Remove error on user typing / changing field
document
  .querySelectorAll("input, textarea, select")
  .forEach((el) => {
    const handler = () => hideError(el.id + "-error");
    el.addEventListener("input", handler);
    el.addEventListener("change", handler);
  });

// Strict email & permissive phone
const validateEmail = (email) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);
const validatePhone = (phone) =>
  /^[+]?[(]?[0-9]{1,4}[)]?[-\s.]?[0-9]{1,3}[-\s.]?[0-9]{3,6}$/im.test(phone);

// Button loading state
function setButtonLoading(btn, isLoading = true) {
  if (!btn) return;
  btn.setAttribute("data-loading", isLoading ? "true" : "false");
  btn.setAttribute("aria-busy", isLoading ? "true" : "false");
  btn.disabled = !!isLoading;
}

// Fieldset lock/unlock
function lockForm(form, locked = true) {
  if (!form) return;
  [...form.querySelectorAll("input, textarea, button, select")].forEach((el) => {
    if (locked) el.setAttribute("disabled", "disabled");
    else el.removeAttribute("disabled");
  });
}

// Overlays
function showOverlay(id) {
  const el = document.getElementById(id);
  if (el) {
    el.classList.remove("hidden");
    el.setAttribute("aria-hidden", "false");
  }
}
function hideOverlay(id) {
  const el = document.getElementById(id);
  if (el) {
    el.classList.add("hidden");
    el.setAttribute("aria-hidden", "true");
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
// Role → Specialization linkage
// -------------------------------
const roleSelect = document.getElementById("signup-role");
const specializationSelect = document.getElementById("signup-specialization");

function updateSpecializationOptions() {
  if (!roleSelect || !specializationSelect) return;

  const role = roleSelect.value;

  // Reset options
  specializationSelect.innerHTML =
    '<option value="">Select specialization</option>';

  if (role === "admin") {
    const opt = document.createElement("option");
    opt.value = "Administrator";
    opt.textContent = "Administrator";
    specializationSelect.appendChild(opt);
  } else if (role === "radiologist") {
    const opt = document.createElement("option");
    opt.value = "Radiologist";
    opt.textContent = "Radiologist";
    specializationSelect.appendChild(opt);
  }

  // Whenever role changes, clear previous specialization error
  hideError("signup-specialization-error");
}

roleSelect?.addEventListener("change", () => {
  hideError("signup-role-error");
  updateSpecializationOptions();
});

// Initialize specialization once on load (in case role is pre-selected for some reason)
updateSpecializationOptions();

// -------------------------------
// Tab Switch (same UX, keyboard-safe)
// -------------------------------
document.querySelectorAll(".auth-tab").forEach((tab) => {
  tab.addEventListener("click", () => switchTab(tab.dataset.tab));
  tab.addEventListener("keydown", (e) => {
    if (e.key === "Enter" || e.key === " ") {
      e.preventDefault();
      switchTab(tab.dataset.tab);
    }
  });
});

function switchTab(name) {
  document.querySelectorAll(".auth-tab").forEach((t) => {
    t.classList.toggle("active", t.dataset.tab === name);
    t.setAttribute(
      "aria-selected",
      t.dataset.tab === name ? "true" : "false"
    );
  });
  document
    .querySelectorAll(".auth-form")
    .forEach((f) => f.classList.remove("active"));
  const pane = document.getElementById(`${name}-form`);
  if (pane) pane.classList.add("active");
}

document.getElementById("show-signup")?.addEventListener("click", (e) => {
  e.preventDefault();
  switchTab("signup");
});
document.getElementById("show-login")?.addEventListener("click", (e) => {
  e.preventDefault();
  switchTab("login");
});

// -------------------------------
// Modals
// -------------------------------
function openModal(modal) {
  if (!modal) return;
  modal.style.display = "flex";
}
function closeModal(modal) {
  if (!modal) return;
  modal.style.display = "none";
}

document.getElementById("forgot-password")?.addEventListener("click", () =>
  openModal(document.getElementById("forgot-password-modal"))
);

// ========== RESEND VERIFICATION MODAL HANDLER ==========
document.getElementById("resend-verification")?.addEventListener("click", () => {
  openModal(document.getElementById("resend-verification-modal"));
});

document.getElementById("admin-login-btn")?.addEventListener("click", () =>
  openModal(document.getElementById("admin-login-modal"))
);

document.querySelectorAll(".close-modal").forEach((btn) => {
  btn.addEventListener("click", () => closeModal(btn.closest(".modal")));
});
window.addEventListener("click", (e) => {
  if (e.target.classList.contains("modal")) closeModal(e.target);
});

// -------------------------------
// LOGIN (with animated states + new structure) - UPDATED
// -------------------------------
document.getElementById("loginForm")?.addEventListener("submit", async (e) => {
  e.preventDefault();

  const email = document.getElementById("login-email").value.trim();
  const password = document.getElementById("login-password").value;

  let valid = true;
  if (!validateEmail(email)) {
    showError("login-email-error", "Enter valid email");
    valid = false;
  }
  if (password.length < 7) {
    showError("login-password-error", "Min 7 chars");
    valid = false;
  }
  if (!valid) return;

  const btn = document.getElementById("loginSubmitBtn");

  try {
    // Animate
    setButtonLoading(btn, true);
    showOverlay("loginProcessing");
    lockForm(e.target, true);

    // 1) Check existence in Firestore (new structure + legacy fallback)
    const existing = await findRadiologistByEmail(email);
    if (!existing) {
      showToast("No account found with this email. Please sign up.", "error");
      return;
    }

    // IMPORTANT FIX: Check if user is trying to login as admin from radiologist login form
    const userData = existing.doc.data() || {};
    if (userData.role === "admin") {
      // Admin trying to login via radiologist login form - BLOCK
      showToast("No Radiologist found with this email.", "error");
      return;
    }

    // 2) Auth sign in
    const { user } = await auth.signInWithEmailAndPassword(email, password);

    // 3) Email verification check
    if (!user.emailVerified) {
      showToast(
        "Please verify your email before logging in. Verification email sent.",
        "info"
      );
      await user.sendEmailVerification();
      await auth.signOut();
      return;
    }

    // 4) Load user doc by UID (auto-migrate legacy → new structure if needed)
    const userDocInfo = await getRadiologistDocByUid(user.uid);
    if (!userDocInfo) {
      showToast("Account record missing. Please contact support.", "error");
      await auth.signOut();
      return;
    }

    const data = userDocInfo.doc.data() || {};
    const status = data.status || (data.approved ? "approved" : "pending");

    // Role-based redirect with status check
    if (data.role === "admin") {
      // This should not happen because we already blocked admin above, but as safety
      showToast("No Radiologist found with this email.", "error");
      await auth.signOut();
      return;
    } else if (data.role === "radiologist" && data.approved) {
      // IMMEDIATE REDIRECT - No delay
      window.location.href = "dashboard.html";
      return; // Important: Return immediately after redirect
    } else {
      showToast("Account pending approval or has been declined.", "error");
      await auth.signOut();
    }
  } catch (err) {
    let msg = "Login failed.";
    if (err.code === "auth/user-not-found")
      msg = "No account found with this email.";
    else if (err.code === "auth/wrong-password")
      msg = "Incorrect password. Please try again.";
    else if (err.code === "auth/too-many-requests")
      msg = "Too many attempts. Try again later.";
    else if (err.message) msg = err.message;
    showToast(msg, "error");
  } finally {
    // Reset UI
    hideOverlay("loginProcessing");
    setButtonLoading(document.getElementById("loginSubmitBtn"), false);
    lockForm(e.target, false);
  }
});

// -------------------------------
// SIGNUP (with animated states + new structure + role-aware)
// -------------------------------
document.getElementById("signupForm")?.addEventListener("submit", async (e) => {
  e.preventDefault();

  const name = document.getElementById("signup-name").value.trim();
  const email = document.getElementById("signup-email").value.trim();
  const role = document.getElementById("signup-role").value; // "admin" or "radiologist"
  const specialization = document.getElementById("signup-specialization").value;
  const institution = document.getElementById("signup-institution").value.trim();
  const phone = document.getElementById("signup-phone").value.trim();
  const address = document.getElementById("signup-address").value.trim();
  const password = document.getElementById("signup-password").value;
  const confirmPassword = document.getElementById("signup-confirm").value;

  let valid = true;
  if (!name) {
    showError("signup-name-error", "Name required");
    valid = false;
  }
  if (!validateEmail(email)) {
    showError("signup-email-error", "Valid email required");
    valid = false;
  }
  if (!role) {
    showError("signup-role-error", "Role required");
    valid = false;
  }
  if (!specialization) {
    showError("signup-specialization-error", "Specialization required");
    valid = false;
  }
  if (!institution) {
    showError("signup-institution-error", "Institution required");
    valid = false;
  }
  if (!validatePhone(phone)) {
    showError("signup-phone-error", "Valid phone required");
    valid = false;
  }
  if (!address) {
    showError("signup-address-error", "Address required");
    valid = false;
  }
  if (password.length < 6) {
    showError("signup-password-error", "Min 6 chars");
    valid = false;
  }
  if (password !== confirmPassword) {
    showError("signup-confirm-error", "Passwords do not match");
    valid = false;
  }

  if (!valid) return;

  const btn = document.getElementById("signupSubmitBtn");

  try {
    // Animate
    setButtonLoading(btn, true);
    showOverlay("signupProcessing");
    lockForm(e.target, true);

    // Create auth account
    const { user } = await auth.createUserWithEmailAndPassword(email, password);

    // Write doc into hierarchical structure
    await radiologistsCollection().doc(user.uid).set({
      name,
      email,
      role: role === "admin" ? "admin" : "radiologist", // backend role
      specialization, // "Administrator" or "Radiologist"
      institution,
      phone,
      address,
      createdAt: new Date(),
      approved: false,
      status: "pending", // helpful for email + admin notify
    });

    // Node.js email server ko signup info bhejna
    try {
      if (role === "admin") {
        // Admin signup → admin ko + system ko notification
        await postEmail("/email/admin-signup", {
          adminEmail: email,
          adminName: name,
          adminPhone: phone,
          adminInstitution: institution,
        });
      } else {
        // Radiologist signup → radiologist + approved admins ko notify karega

        const adminsSnap = await radiologistsCollection()
          .where("role", "==", "admin")
          .where("status", "==", "approved")
          .get();

        const adminEmails = adminsSnap.docs
          .map((d) => (d.data() && d.data().email) || null)
          .filter((x) => !!x);

        await postEmail("/email/radiologist-signup", {
          radiologistEmail: email,
          radiologistName: name,
          specialization,
          institution,
          adminEmails, // empty array bhi ho sakta hai, server side handle karega
        });
      }
    } catch (emailErr) {
      console.error("Signup email call failed:", emailErr);
      // User ko block nahi karna, sirf log rakhna hai
    }

    // Firebase built-in verification email
    await user.sendEmailVerification();

    showToast(
      "Registered! Please verify your email & wait for approval.",
      "success"
    );

    // Reset & switch to login tab
    e.target.reset();
    updateSpecializationOptions(); // reset specialization dropdown
    switchTab("login");
  } catch (err) {
    const msg =
      err?.code === "auth/email-already-in-use"
        ? "Email already in use."
        : err?.message || "Signup failed.";
    showToast(msg, "error");
  } finally {
    hideOverlay("signupProcessing");
    setButtonLoading(document.getElementById("signupSubmitBtn"), false);
    lockForm(e.target, false);
  }
});

// -------------------------------
// FORGOT PASSWORD 
// -------------------------------
document
  .getElementById("forgotPasswordForm")
  ?.addEventListener("submit", async (e) => {
    e.preventDefault();
    const email = document.getElementById("reset-email").value.trim();
    const btn = document.getElementById("forgotSubmitBtn");

    if (!validateEmail(email)) {
      showError("reset-email-error", "Valid email required");
      return;
    }

    try {
      setButtonLoading(btn, true);
      lockForm(e.target, true);

      // Check in new structure + legacy
      const existing = await findRadiologistByEmail(email);
      if (!existing) {
        showToast(
          "No account found with this email. Please sign up.",
          "error"
        );
        return;
      }

      await auth.sendPasswordResetEmail(email);
      showToast("Reset link sent to email.", "success");
      closeModal(document.getElementById("forgot-password-modal"));
      e.target.reset();
    } catch (err) {
      let msg = "Failed to send reset email.";
      if (err.code === "auth/user-not-found")
        msg = "No auth account for that email.";
      else if (err.code === "auth/too-many-requests")
        msg = "Too many requests. Try later.";
      else if (err.message) msg = err.message;
      showToast(msg, "error");
    } finally {
      setButtonLoading(btn, false);
      lockForm(e.target, false);
    }
  });

// ========== RESEND VERIFICATION EMAIL (NEW) ==========
document
  .getElementById("resendVerificationForm")
  ?.addEventListener("submit", async (e) => {
    e.preventDefault();
    
    const email = document.getElementById("resend-email").value.trim();
    const btn = document.getElementById("resendSubmitBtn");
    
    // Email validation
    if (!validateEmail(email)) {
      showError("resend-email-error", "Please enter a valid email address");
      return;
    }
    
    try {
      setButtonLoading(btn, true);
      lockForm(e.target, true);
      
      // 1. Check if email exists in Firestore (new structure + legacy)
      const existing = await findRadiologistByEmail(email);
      
      if (!existing) {
        showError("resend-email-error", "No account found with this email");
        showToast("No registered account found. Please sign up first.", "error");
        return;
      }
      
      const userData = existing.doc.data();
      const uid = existing.doc.id;
      
      // 2. Check if account is approved/rejected
      const status = userData.status || (userData.approved ? "approved" : "pending");
      
      if (status === "rejected" || (userData.approved === false && userData.status !== "pending")) {
        showError("resend-email-error", "Account has been rejected");
        showToast("Your account application was rejected. Contact support.", "error");
        return;
      }
      
      // 3. Try to get the user from Firebase Auth
      // First, check if user is already logged in
      let user = auth.currentUser;
      
      if (!user || user.email !== email) {
        // User is not logged in - we need to fetch user by email
        try {
          // Get user by re-authenticating
          // We'll try to sign in with the user's email (but we don't have password)
          // Instead, we'll use fetchSignInMethodsForEmail to check if user exists
          const methods = await auth.fetchSignInMethodsForEmail(email);
          
          if (!methods || methods.length === 0) {
            showError("resend-email-error", "Authentication account not found");
            showToast("No authentication account found for this email.", "error");
            return;
          }
          
          // User exists in auth but we can't resend verification without password
          // Show message to login first
          showError("resend-email-error", "Please login first to resend verification");
          showToast("Please login with your password first, then try again.", "info");
          
          // Switch to login tab and pre-fill email
          switchTab("login");
          document.getElementById("login-email").value = email;
          closeModal(document.getElementById("resend-verification-modal"));
          return;
          
        } catch (authErr) {
          console.error("Auth error:", authErr);
          showError("resend-email-error", "Authentication error. Please try logging in first.");
          showToast("Authentication error. Please try logging in first.", "error");
          return;
        }
      }
      
      // 4. If we have the user, check if already verified
      if (user) {
        // Reload user to get latest emailVerified status
        await user.reload();
        user = auth.currentUser; // Get updated user object
        
        if (user.emailVerified) {
          showError("resend-email-error", "Email is already verified");
          showToast("Your email is already verified. You can login now.", "success");
          return;
        }
        
        // 5. Resend verification email
        await user.sendEmailVerification();
        
        showToast("Verification email sent successfully! Check your inbox.", "success");
        closeModal(document.getElementById("resend-verification-modal"));
        e.target.reset();
        
      } else {
        // This shouldn't happen, but just in case
        showError("resend-email-error", "Please login first");
        showToast("Please login first, then use this feature.", "info");
        
        // Auto-switch to login tab
        switchTab("login");
        document.getElementById("login-email").value = email;
        closeModal(document.getElementById("resend-verification-modal"));
      }
      
    } catch (err) {
      console.error("Resend verification error:", err);
      
      let errorMsg = "Failed to resend verification email";
      
      if (err.code === "auth/too-many-requests") {
        errorMsg = "Too many attempts. Please try again later.";
      } else if (err.code === "auth/user-not-found") {
        errorMsg = "No authentication account found for this email";
      } else if (err.code === "auth/user-disabled") {
        errorMsg = "Account has been disabled. Contact support.";
      } else if (err.message) {
        errorMsg = err.message;
      }
      
      showError("resend-email-error", errorMsg);
      showToast(errorMsg, "error");
      
    } finally {
      setButtonLoading(btn, false);
      lockForm(e.target, false);
    }
  });

// -------------------------------
// ADMIN LOGIN (animated + new structure-aware) - UPDATED
// -------------------------------
document
  .getElementById("adminLoginForm")
  ?.addEventListener("submit", async (e) => {
    e.preventDefault();

    const email = document.getElementById("admin-email").value.trim();
    const password = document.getElementById("admin-password").value;
    let valid = true;

    if (!validateEmail(email)) {
      showError("admin-email-error", "Valid email required");
      valid = false;
    }
    if (password.length < 6) {
      showError("admin-password-error", "Min 6 chars");
      valid = false;
    }
    if (!valid) return;

    const btn = document.getElementById("adminSubmitBtn");

    try {
      // Animate
      setButtonLoading(btn, true);
      showOverlay("adminProcessing");
      lockForm(e.target, true);

      // 1) Check admin record (new structure first, then legacy)
      const adminRecord = await findAdminByEmail(email);
      if (!adminRecord) {
        showToast("No admin account found with this email.", "error");
        return;
      }

      // 2) sign in (Firebase Auth)
      const { user } = await auth.signInWithEmailAndPassword(email, password);

      // 3) Verify role by UID (also auto-migrate if legacy only)
      const userDocInfo = await getRadiologistDocByUid(user.uid);
      const data = userDocInfo?.doc?.data() || {};
      const status = data.status || (data.approved ? "approved" : "pending");

      if (!userDocInfo || data.role !== "admin") {
        showToast("Access denied. Admin only.", "error");
        await auth.signOut();
        return;
      }

      if (status !== "approved" && !data.approved) {
        showToast(
          "Admin account pending approval or deactivated. Please contact support.",
          "error"
        );
        await auth.signOut();
        return;
      }

      // IMMEDIATE REDIRECT - No delay
      window.location.href = "admin.html";
      return; // Important: Return immediately after redirect
    } catch (err) {
      let msg = "Admin login failed.";
      if (err.code === "auth/user-not-found") msg = "Admin not found.";
      else if (err.code === "auth/wrong-password") msg = "Wrong password.";
      else if (err.code === "auth/too-many-requests")
        msg = "Too many attempts. Try later.";
      else if (err.message) msg = err.message;
      showToast(msg, "error");
    } finally {
      hideOverlay("adminProcessing");
      setButtonLoading(document.getElementById("adminSubmitBtn"), false);
      lockForm(e.target, false);
    }
  });