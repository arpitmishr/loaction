// js/admin.js

// 1. Consolidated Imports
import { onAuthStateChanged } from "https://www.gstatic.com/firebasejs/11.2.0/firebase-auth.js";
import { 
    doc, getDoc, collection, getDocs, query, where, Timestamp, 
    addDoc, updateDoc, serverTimestamp, orderBy 
} from "https://www.gstatic.com/firebasejs/11.2.0/firebase-firestore.js";
import { auth, db } from "./firebase.js";
import { logoutUser } from "./auth.js";

const content = document.getElementById('content');
const loader = document.getElementById('loader');

// --- 2. Main Execution (Auth Guard) ---
onAuthStateChanged(auth, async (user) => {
    // A. Not Logged In -> Redirect
    if (!user) {
        window.location.href = 'index.html';
        return;
    }

    try {
        // B. Check Admin Role
        const userDoc = await getDoc(doc(db, "users", user.uid));
        
        if (!userDoc.exists() || userDoc.data().role !== 'admin') {
            alert("Access Denied: Admins Only.");
            await logoutUser();
            return;
        }

        // C. SUCCESS: Hide Loader & Show Content
        if (loader) loader.style.display = 'none';
        if (content) content.style.display = 'block';
        
        if(document.getElementById('user-email')) {
            document.getElementById('user-email').innerText = user.email;
        }

        // D. Load Data (After UI is visible)
        // We run these separately so one failure doesn't stop the others
        loadDashboardStats();
        loadTodayAttendance();
        loadOutlets(); 
        loadSalesmenList();
        
        // E. Setup Forms
        setupOutletForm();

    } catch (error) {
        console.error("Dashboard Init Error:", error);
        if (loader) loader.innerText = "Error loading dashboard. Check console.";
        alert("Error: " + error.message);
    }
});

// Logout Listener
const logoutBtn = document.getElementById('logoutBtn');
if (logoutBtn) logoutBtn.addEventListener('click', logoutUser);


// --- 3. CORE DASHBOARD LOGIC ---

async function loadDashboardStats() {
    try {
        // Define "Today"
        const now = new Date();
        const startOfDay = new Date(now.getFullYear(), now.getMonth(), now.getDate());
        const endOfDay = new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1);

        const startTs = Timestamp.fromDate(startOfDay);
        const endTs = Timestamp.fromDate(endOfDay);

        // Execute Queries
        // Note: These might require indexes. Check Console if data is missing.
        const [attendanceSnap, ordersSnap, outletsSnap] = await Promise.all([
            getDocs(query(collection(db, "attendance"), where("checkInTime", ">=", startTs), where("checkInTime", "<", endTs))),
            getDocs(query(collection(db, "orders"), where("orderDate", ">=", startTs), where("orderDate", "<", endTs))),
            getDocs(collection(db, "outlets"))
        ]);

        // Calculate Stats
        const attendanceCount = attendanceSnap.size;
        let totalOrders = ordersSnap.size;
        let totalSales = 0;
        
        ordersSnap.forEach(doc => {
            totalSales += Number(doc.data().totalAmount) || 0;
        });

        let totalCredit = 0;
        outletsSnap.forEach(doc => {
            totalCredit += Number(doc.data().currentBalance) || 0;
        });

        // Update UI (Check if elements exist first)
        const elAttend = document.getElementById('stat-attendance');
        const elOrders = document.getElementById('stat-orders');
        const elSales = document.getElementById('stat-sales');
        const elCredit = document.getElementById('stat-credit');

        if(elAttend) elAttend.innerText = attendanceCount;
        if(elOrders) elOrders.innerText = totalOrders;
        if(elSales) elSales.innerText = formatCurrency(totalSales);
        if(elCredit) elCredit.innerText = formatCurrency(totalCredit);

    } catch (error) {
        console.error("Error loading stats (Likely missing Index):", error);
    }
}

async function loadTodayAttendance() {
    const list = document.getElementById('attendance-list');
    if (!list) return;

    const d = new Date();
    const todayStr = d.getFullYear() + "-" + 
           String(d.getMonth() + 1).padStart(2, '0') + "-" + 
           String(d.getDate()).padStart(2, '0');

    try {
        const q = query(
            collection(db, "attendance"),
            where("date", "==", todayStr),
            orderBy("checkInTime", "desc")
        );

        const snap = await getDocs(q);
        list.innerHTML = "";

        if (snap.empty) {
            list.innerHTML = "<tr><td colspan='3' style='padding:15px; text-align:center'>No check-ins today.</td></tr>";
            return;
        }

        snap.forEach(doc => {
            const data = doc.data();
            const time = data.checkInTime ? data.checkInTime.toDate().toLocaleTimeString([], {hour: '2-digit', minute:'2-digit'}) : 'N/A';
            
            // Handle missing location safely
            let mapLink = "No Loc";
            if (data.location) {
                const lat = data.location.latitude;
                const lng = data.location.longitude;
                mapLink = `<a href="https://www.google.com/maps/search/?api=1&query=${lat},${lng}" target="_blank" style="color: #007bff; text-decoration: none;">View 📍</a>`;
            }

            const row = `
                <tr style="border-bottom: 1px solid #eee;">
                    <td style="padding: 10px;">${data.salesmanEmail || 'Unknown'}</td>
                    <td>${time}</td>
                    <td>${mapLink}</td>
                </tr>
            `;
            list.innerHTML += row;
        });

    } catch (error) {
        console.error("Attendance Load Error:", error);
        if(error.message.includes("index")) {
            list.innerHTML = "<tr><td colspan='3' style='color:red'>Missing Index. Check Console (F12).</td></tr>";
        }
    }
}

// --- 4. OUTLET MANAGEMENT ---

// --- OUTLET MANAGEMENT FUNCTIONS ---

function setupOutletForm() {
    const form = document.getElementById('addOutletForm');
    const geoBtn = document.getElementById('geoBtn');
    const storeTypeSelect = document.getElementById('storeType');
    const creditDaysInput = document.getElementById('creditDays');
    const creditLimitInput = document.getElementById('creditLimit');
    
    if (!form) return;

    // 1. Dynamic Toggle: Enable/Disable Credit fields
    storeTypeSelect.addEventListener('change', (e) => {
        if (e.target.value === 'Credit') {
            creditDaysInput.disabled = false;
            creditLimitInput.disabled = false;
            creditDaysInput.required = true;
            creditLimitInput.required = true;
        } else {
            creditDaysInput.disabled = true;
            creditLimitInput.disabled = true;
            creditDaysInput.required = false;
            creditLimitInput.required = false;
            creditDaysInput.value = "";
            creditLimitInput.value = "";
        }
    });

    // 2. Handle Geolocation
    geoBtn.addEventListener('click', () => {
        const display = document.getElementById('geoDisplay');
        const btn = document.getElementById('geoBtn');

        if (!navigator.geolocation) {
            alert("Geolocation not supported");
            return;
        }

        btn.innerText = "Locating...";
        
        navigator.geolocation.getCurrentPosition(
            (pos) => {
                document.getElementById('lat').value = pos.coords.latitude;
                document.getElementById('lng').value = pos.coords.longitude;
                display.innerText = `✅ Lat: ${pos.coords.latitude.toFixed(4)}, Lng: ${pos.coords.longitude.toFixed(4)}`;
                display.style.color = "green";
                btn.innerText = "📍 Update Location";
            },
            (err) => {
                console.error(err);
                alert("Could not get location. Ensure GPS is on.");
                btn.innerText = "Retry GPS";
            }
        );
    });

    // 3. Handle Submit (Add OR Edit)
    form.addEventListener('submit', async (e) => {
        e.preventDefault();
        const submitBtn = document.getElementById('submitBtn');
        const editId = document.getElementById('editOutletId').value; // Check if we are editing
        
        submitBtn.disabled = true;
        submitBtn.innerText = editId ? "Updating..." : "Saving...";

        const lat = document.getElementById('lat').value;
        const lng = document.getElementById('lng').value;

        if (!lat || !lng) {
            alert("Please capture GPS Location first.");
            submitBtn.disabled = false;
            submitBtn.innerText = editId ? "Update Outlet" : "Save Outlet";
            return;
        }

        try {
            // Prepare Data Object
            const outletData = {
                shopName: document.getElementById('shopName').value.trim(),
                outletType: document.getElementById('outletType').value,
                ownerName: document.getElementById('ownerName').value.trim(),
                contactPerson: document.getElementById('contactPerson').value.trim(),
                contactPhone: document.getElementById('contactPhone').value.trim(),
                gstNumber: document.getElementById('gstNumber').value.trim() || "N/A",
                storeType: document.getElementById('storeType').value,
                creditDays: document.getElementById('creditDays').value ? Number(document.getElementById('creditDays').value) : 0,
                creditLimit: document.getElementById('creditLimit').value ? Number(document.getElementById('creditLimit').value) : 0,
                geo: { lat: parseFloat(lat), lng: parseFloat(lng) },
                // Don't overwrite status or createdAt on edit unless necessary
            };

            if (editId) {
                // --- UPDATE EXISTING ---
                const docRef = doc(db, "outlets", editId);
                await updateDoc(docRef, outletData);
                alert("Outlet Updated Successfully!");
            } else {
                // --- CREATE NEW ---
                outletData.status = 'active';
                outletData.currentBalance = 0;
                outletData.createdAt = serverTimestamp();
                await addDoc(collection(db, "outlets"), outletData);
                alert("Outlet Added Successfully!");
            }

            cancelEdit(); // Helper to reset form
            loadOutlets(); // Refresh Table

        } catch (error) {
            console.error("Save Error:", error);
            alert("Error: " + error.message);
        } finally {
            submitBtn.disabled = false;
            submitBtn.innerText = editId ? "Update Outlet" : "Save Outlet";
        }
    });
}

// Global Function: Populate form for Editing
window.editOutlet = async function(id) {
    try {
        // Scroll to form
        document.getElementById('addOutletForm').scrollIntoView({ behavior: 'smooth' });

        const docRef = doc(db, "outlets", id);
        const docSnap = await getDoc(docRef);

        if (!docSnap.exists()) {
            alert("Outlet not found!");
            return;
        }

        const data = docSnap.data();

        // 1. Fill Hidden ID
        document.getElementById('editOutletId').value = id;

        // 2. Fill Text/Select Inputs
        document.getElementById('shopName').value = data.shopName;
        document.getElementById('outletType').value = data.outletType;
        document.getElementById('ownerName').value = data.ownerName;
        document.getElementById('contactPerson').value = data.contactPerson;
        document.getElementById('contactPhone').value = data.contactPhone;
        document.getElementById('gstNumber').value = data.gstNumber;
        document.getElementById('storeType').value = data.storeType;

        // 3. Handle Credit Logic
        const creditDaysInput = document.getElementById('creditDays');
        const creditLimitInput = document.getElementById('creditLimit');
        
        if (data.storeType === 'Credit') {
            creditDaysInput.disabled = false;
            creditLimitInput.disabled = false;
            creditDaysInput.value = data.creditDays;
            creditLimitInput.value = data.creditLimit;
        } else {
            creditDaysInput.disabled = true;
            creditLimitInput.disabled = true;
            creditDaysInput.value = "";
            creditLimitInput.value = "";
        }

        // 4. Fill GPS (Keep existing unless they click capture again)
        document.getElementById('lat').value = data.geo.lat;
        document.getElementById('lng').value = data.geo.lng;
        document.getElementById('geoDisplay').innerText = `Existing: ${data.geo.lat}, ${data.geo.lng}`;
        document.getElementById('geoDisplay').style.color = "blue";

        // 5. Update UI Buttons
        document.getElementById('formTitle').innerText = "Edit Outlet";
        document.getElementById('submitBtn').innerText = "Update Outlet";
        document.getElementById('cancelEditBtn').style.display = "block";

    } catch (error) {
        console.error("Edit fetch error:", error);
        alert("Failed to fetch outlet details.");
    }
};

// Global Function: Reset Form
window.cancelEdit = function() {
    document.getElementById('addOutletForm').reset();
    document.getElementById('editOutletId').value = ""; // Clear ID
    document.getElementById('formTitle').innerText = "Add New Outlet";
    document.getElementById('submitBtn').innerText = "Save Outlet";
    document.getElementById('cancelEditBtn').style.display = "none";
    
    // Reset GPS UI
    document.getElementById('geoDisplay').innerText = "Location required";
    document.getElementById('geoDisplay').style.color = "#333";
    document.getElementById('lat').value = "";
    document.getElementById('lng').value = "";
    
    // Reset Credit inputs
    document.getElementById('creditDays').disabled = true;
    document.getElementById('creditLimit').disabled = true;
};

async function loadOutlets() {
    const tableBody = document.getElementById('outlets-table-body');
    if (!tableBody) return;
    
    try {
        const q = query(collection(db, "outlets")); 
        const snap = await getDocs(q);

        tableBody.innerHTML = "";

        if (snap.empty) {
            tableBody.innerHTML = "<tr><td colspan='6'>No outlets found.</td></tr>";
            return;
        }

        snap.forEach(docSnap => {
            const data = docSnap.data();
            const id = docSnap.id;
            const isBlocked = data.status === 'blocked';
            
            // Status Badge
            const statusBadge = isBlocked 
                ? `<span style="background:#f8d7da; color:#721c24; padding:3px 8px; border-radius:12px; font-size:0.8rem;">Blocked</span>` 
                : `<span style="background:#d4edda; color:#155724; padding:3px 8px; border-radius:12px; font-size:0.8rem;">Active</span>`;

            // Action Buttons (Block & Edit)
            const blockBtn = isBlocked
                ? `<button style="background:#28a745; color:white; border:none; padding:4px 8px; margin-right:5px; border-radius:4px; cursor:pointer;" onclick="toggleOutletStatus('${id}', 'active')">Unblock</button>`
                : `<button style="background:#dc3545; color:white; border:none; padding:4px 8px; margin-right:5px; border-radius:4px; cursor:pointer;" onclick="toggleOutletStatus('${id}', 'blocked')">Block</button>`;

            const editBtn = `<button style="background:#007bff; color:white; border:none; padding:4px 8px; border-radius:4px; cursor:pointer;" onclick="editOutlet('${id}')">Edit</button>`;

            const creditInfo = data.storeType === 'Credit' 
                ? `<small style="color:#d63384;">Limit: ₹${data.creditLimit}<br>Days: ${data.creditDays}</small>` 
                : `<small style="color:#28a745;">Cash Only</small>`;

            const row = `
                <tr>
                    <td>
                        <strong>${data.shopName}</strong>
                        <br><small style="color:#666;">${data.outletType}</small>
                    </td>
                    <td>
                        ${data.contactPerson}
                        <br><small><a href="tel:${data.contactPhone}">${data.contactPhone}</a></small>
                    </td>
                    <td>
                        ${data.storeType}
                        <br>${creditInfo}
                    </td>
                    <td><small>${data.gstNumber}</small></td>
                    <td>${statusBadge}</td>
                    <td>
                        ${editBtn}
                        ${blockBtn}
                    </td>
                </tr>
            `;
            tableBody.innerHTML += row;
        });

    } catch (error) {
        console.error("Load Outlets Error:", error);
        tableBody.innerHTML = "<tr><td colspan='6'>Error loading data.</td></tr>";
    }
}
