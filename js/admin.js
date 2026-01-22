// js/admin.js

// 1. IMPORTS
import { onAuthStateChanged } from "https://www.gstatic.com/firebasejs/11.2.0/firebase-auth.js";
import { 
    doc, getDoc, collection, getDocs, query, where, Timestamp, 
    addDoc, updateDoc, serverTimestamp, orderBy 
} from "https://www.gstatic.com/firebasejs/11.2.0/firebase-firestore.js";
import { auth, db } from "./firebase.js";
import { logoutUser } from "./auth.js";

const content = document.getElementById('content');
const loader = document.getElementById('loader');

// --- 2. MAIN EXECUTION ---
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

        // D. Setup Forms (Do this immediately so listeners attach)
        setupOutletForm();

        // E. Load Data
        loadDashboardStats();
        loadTodayAttendance();
        loadOutlets(); 
        loadSalesmenList(); // This function is now defined below

    } catch (error) {
        console.error("Dashboard Init Error:", error);
        alert("Error: " + error.message);
    }
});

// Logout Listener
const logoutBtn = document.getElementById('logoutBtn');
if (logoutBtn) logoutBtn.addEventListener('click', logoutUser);


// --- 3. DASHBOARD STATS LOGIC ---

async function loadDashboardStats() {
    try {
        const now = new Date();
        const startOfDay = new Date(now.getFullYear(), now.getMonth(), now.getDate());
        const endOfDay = new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1);
        const startTs = Timestamp.fromDate(startOfDay);
        const endTs = Timestamp.fromDate(endOfDay);

        const [attendanceSnap, ordersSnap, outletsSnap] = await Promise.all([
            getDocs(query(collection(db, "attendance"), where("checkInTime", ">=", startTs), where("checkInTime", "<", endTs))),
            getDocs(query(collection(db, "orders"), where("orderDate", ">=", startTs), where("orderDate", "<", endTs))),
            getDocs(collection(db, "outlets"))
        ]);

        let totalSales = 0;
        ordersSnap.forEach(doc => totalSales += Number(doc.data().totalAmount) || 0);

        let totalCredit = 0;
        outletsSnap.forEach(doc => totalCredit += Number(doc.data().currentBalance) || 0);

        const elAttend = document.getElementById('stat-attendance');
        const elOrders = document.getElementById('stat-orders');
        const elSales = document.getElementById('stat-sales');
        const elCredit = document.getElementById('stat-credit');

        if(elAttend) elAttend.innerText = attendanceSnap.size;
        if(elOrders) elOrders.innerText = ordersSnap.size;
        if(elSales) elSales.innerText = formatCurrency(totalSales);
        if(elCredit) elCredit.innerText = formatCurrency(totalCredit);

    } catch (error) {
        console.error("Stats Error (Check Indexes):", error);
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
            list.innerHTML = "<tr><td colspan='3' style='text-align:center'>No check-ins today.</td></tr>";
            return;
        }
        snap.forEach(doc => {
            const data = doc.data();
            const time = data.checkInTime ? data.checkInTime.toDate().toLocaleTimeString([], {hour: '2-digit', minute:'2-digit'}) : 'N/A';
            let mapLink = data.location 
                ? `<a href="https://www.google.com/maps/search/?api=1&query=${data.location.latitude},${data.location.longitude}" target="_blank">View 📍</a>` 
                : "No Loc";
            
            list.innerHTML += `<tr style="border-bottom: 1px solid #eee;"><td style="padding:10px;">${data.salesmanEmail}</td><td>${time}</td><td>${mapLink}</td></tr>`;
        });
    } catch (error) {
        console.error("Attendance Error:", error);
    }
}

// --- 4. SALESMAN LIST (WAS MISSING) ---

async function loadSalesmenList() {
    const list = document.getElementById('salesmen-list');
    if(!list) return;
    list.innerHTML = '<li>Loading...</li>';

    try {
        const q = query(collection(db, "users"), where("role", "==", "salesman"));
        const snap = await getDocs(q);
        
        list.innerHTML = "";
        if(snap.empty) { list.innerHTML = "<li>No active salesmen found.</li>"; return; }

        snap.forEach(doc => {
            const d = doc.data();
            const li = document.createElement('li');
            li.textContent = `👤 ${d.fullName || d.email} ${d.phone ? ' - ' + d.phone : ''}`;
            li.style.padding = "5px 0";
            list.appendChild(li);
        });
    } catch (e) {
        console.error("Salesmen List Error:", e);
        list.innerHTML = "<li>Error loading list.</li>";
    }
}

// --- 5. OUTLET MANAGEMENT ---

function setupOutletForm() {
    const form = document.getElementById('addOutletForm');
    const geoBtn = document.getElementById('geoBtn');
    const storeTypeSelect = document.getElementById('storeType');
    const creditDaysInput = document.getElementById('creditDays');
    const creditLimitInput = document.getElementById('creditLimit');
    
    if (!form || !storeTypeSelect) return;

    // 1. Dynamic Toggle: Enable/Disable Credit fields
    storeTypeSelect.addEventListener('change', (e) => {
        // Ensure values compare correctly
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
                display.innerText = `✅ Captured`;
                display.style.color = "green";
                btn.innerText = "📍 Update Loc";
            },
            (err) => {
                console.error(err);
                alert("GPS Error. Ensure Location is ON.");
                btn.innerText = "Retry GPS";
            }
        );
    });

    // 3. Handle Submit
    form.addEventListener('submit', async (e) => {
        e.preventDefault();
        const submitBtn = document.getElementById('submitBtn');
        const editId = document.getElementById('editOutletId').value;
        
        submitBtn.disabled = true;
        submitBtn.innerText = "Saving...";

        const lat = document.getElementById('lat').value;
        const lng = document.getElementById('lng').value;

        if (!lat || !lng) {
            alert("Please capture GPS Location first.");
            submitBtn.disabled = false;
            submitBtn.innerText = editId ? "Update Outlet" : "Save Outlet";
            return;
        }

        try {
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
                geo: { lat: parseFloat(lat), lng: parseFloat(lng) }
            };

            if (editId) {
                await updateDoc(doc(db, "outlets", editId), outletData);
                alert("Updated Successfully!");
            } else {
                outletData.status = 'active';
                outletData.currentBalance = 0;
                outletData.createdAt = serverTimestamp();
                await addDoc(collection(db, "outlets"), outletData);
                alert("Added Successfully!");
            }

            cancelEdit();
            loadOutlets();

        } catch (error) {
            console.error("Save Error:", error);
            alert("Error: " + error.message);
        } finally {
            submitBtn.disabled = false;
            submitBtn.innerText = editId ? "Update Outlet" : "Save Outlet";
        }
    });
}

// Global Edit Function
window.editOutlet = async function(id) {
    try {
        document.getElementById('addOutletForm').scrollIntoView({ behavior: 'smooth' });
        const docSnap = await getDoc(doc(db, "outlets", id));

        if (!docSnap.exists()) return;
        const data = docSnap.data();

        document.getElementById('editOutletId').value = id;
        document.getElementById('shopName').value = data.shopName;
        document.getElementById('outletType').value = data.outletType;
        document.getElementById('ownerName').value = data.ownerName;
        document.getElementById('contactPerson').value = data.contactPerson;
        document.getElementById('contactPhone').value = data.contactPhone;
        document.getElementById('gstNumber').value = data.gstNumber;
        document.getElementById('storeType').value = data.storeType;

        // Trigger Credit Logic Manually for Edit Mode
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

        document.getElementById('lat').value = data.geo.lat;
        document.getElementById('lng').value = data.geo.lng;
        document.getElementById('geoDisplay').innerText = "Existing Location Kept";
        document.getElementById('geoDisplay').style.color = "blue";

        document.getElementById('formTitle').innerText = "Edit Outlet";
        document.getElementById('submitBtn').innerText = "Update Outlet";
        document.getElementById('cancelEditBtn').style.display = "block";

    } catch (error) {
        console.error("Edit Error:", error);
    }
};

window.cancelEdit = function() {
    document.getElementById('addOutletForm').reset();
    document.getElementById('editOutletId').value = "";
    document.getElementById('formTitle').innerText = "Add New Outlet";
    document.getElementById('submitBtn').innerText = "Save Outlet";
    document.getElementById('cancelEditBtn').style.display = "none";
    document.getElementById('geoDisplay').innerText = "Location required";
    document.getElementById('geoDisplay').style.color = "#333";
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
        if (snap.empty) { tableBody.innerHTML = "<tr><td colspan='6'>No outlets found.</td></tr>"; return; }

        snap.forEach(docSnap => {
            const data = docSnap.data();
            const id = docSnap.id;
            const isBlocked = data.status === 'blocked';
            
            const statusBadge = isBlocked 
                ? `<span style="background:#f8d7da; color:#721c24; padding:3px 8px; border-radius:12px;">Blocked</span>` 
                : `<span style="background:#d4edda; color:#155724; padding:3px 8px; border-radius:12px;">Active</span>`;

            const blockBtn = isBlocked
                ? `<button style="background:#28a745; color:white; border:none; padding:4px 8px; margin-right:5px; border-radius:4px; cursor:pointer;" onclick="toggleOutletStatus('${id}', 'active')">Unblock</button>`
                : `<button style="background:#dc3545; color:white; border:none; padding:4px 8px; margin-right:5px; border-radius:4px; cursor:pointer;" onclick="toggleOutletStatus('${id}', 'blocked')">Block</button>`;

            const editBtn = `<button style="background:#007bff; color:white; border:none; padding:4px 8px; border-radius:4px; cursor:pointer;" onclick="editOutlet('${id}')">Edit</button>`;

            const creditInfo = data.storeType === 'Credit' 
                ? `<small style="color:#d63384;">Limit: ${data.creditLimit}</small>` 
                : `<small style="color:#28a745;">Cash</small>`;

            const row = `
                <tr>
                    <td><strong>${data.shopName}</strong><br><small style="color:#666;">${data.outletType}</small></td>
                    <td>${data.contactPerson}<br><small><a href="tel:${data.contactPhone}">${data.contactPhone}</a></small></td>
                    <td>${data.storeType}<br>${creditInfo}</td>
                    <td><small>${data.gstNumber}</small></td>
                    <td>${statusBadge}</td>
                    <td>${editBtn} ${blockBtn}</td>
                </tr>`;
            tableBody.innerHTML += row;
        });
    } catch (error) {
        console.error("Load Outlets Error:", error);
    }
}

window.toggleOutletStatus = async function(id, newStatus) {
    if(!confirm(`Change status to ${newStatus}?`)) return;
    try {
        await updateDoc(doc(db, "outlets", id), { status: newStatus });
        loadOutlets();
    } catch (error) { alert("Failed to update status."); }
};

// --- UTILITY (WAS MISSING) ---
function formatCurrency(amount) {
    return new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD' }).format(amount);
}
