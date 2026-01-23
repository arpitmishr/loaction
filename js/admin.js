// js/admin.js

// 1. IMPORTS

import { 
    // ... existing imports ...
    deleteDoc 
} from "https://www.gstatic.com/firebasejs/11.2.0/firebase-firestore.js";

import { onAuthStateChanged } from "https://www.gstatic.com/firebasejs/11.2.0/firebase-auth.js";
import { 
    doc, getDoc, collection, getDocs, query, where, Timestamp, 
    addDoc, updateDoc, serverTimestamp, runTransaction, orderBy 
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
        // ... inside the successful admin check ...
        populateTargetSalesmanDropdown(); 
        
loadRoutes();
populateSalesmanDropdown();
populateAllOutletsDropdown();
        // ... inside the try block ...
loadProducts();
setupProductForm();
        // ... inside onAuthStateChanged ...
loadPendingPayments();
        // Inside the admin success block:
loadPendingLeaves();
// Set default date picker to today
document.getElementById('attendanceDateFilter').valueAsDate = new Date();

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
        // 1. Define "Today" time range
        const now = new Date();
        const startOfDay = new Date(now.getFullYear(), now.getMonth(), now.getDate());
        const endOfDay = new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1);

        const startTs = Timestamp.fromDate(startOfDay);
        const endTs = Timestamp.fromDate(endOfDay);

        // 2. Execute Queries
        const [attendanceSnap, ordersSnap, outletsSnap] = await Promise.all([
            // Attendance Count
            getDocs(query(collection(db, "attendance"), where("checkInTime", ">=", startTs), where("checkInTime", "<", endTs))),
            
            // Orders Today
            getDocs(query(collection(db, "orders"), where("orderDate", ">=", startTs), where("orderDate", "<", endTs))),
            
            // All Outlets (To sum up Credit)
            getDocs(collection(db, "outlets"))
        ]);

        // 3. Calculate "Orders Today" & "Sales Today"
        const attendanceCount = attendanceSnap.size;
        let totalOrders = ordersSnap.size;
        let totalSales = 0;
        
        ordersSnap.forEach(doc => {
            const data = doc.data();
            // Check inside 'financials' object first, fallback to root (backward compatibility)
            const amount = (data.financials && data.financials.totalAmount) ? data.financials.totalAmount : (data.totalAmount || 0);
            totalSales += Number(amount);
        });

        // 4. Calculate "Credit in Market"
        let totalCredit = 0;
        outletsSnap.forEach(doc => {
            const data = doc.data();
            // Sum up currentBalance of all shops
            totalCredit += Number(data.currentBalance) || 0;
        });

        // 5. Update UI
        const elAttend = document.getElementById('stat-attendance');
        const elOrders = document.getElementById('stat-orders');
        const elSales = document.getElementById('stat-sales');
        const elCredit = document.getElementById('stat-credit');

        if(elAttend) elAttend.innerText = attendanceCount;
        if(elOrders) elOrders.innerText = totalOrders;
        if(elSales) elSales.innerText = formatCurrency(totalSales);
        if(elCredit) elCredit.innerText = formatCurrency(totalCredit);

    } catch (error) {
        console.error("Error loading stats:", error);
        // Usually caused by missing index on 'orderDate'
        if(error.message.includes("index")) {
            console.warn("Please create the Index via the link in console.");
        }
    }
}

// ==========================================
//      ATTENDANCE & LEAVE LOGIC
// ==========================================

// 1. Load Today's Data (Called by Init)
async function loadTodayAttendance() {
    // Set the Date Picker Input to Today's Date
    const today = new Date();
    const todayStr = today.getFullYear() + "-" + 
                     String(today.getMonth() + 1).padStart(2, '0') + "-" + 
                     String(today.getDate()).padStart(2, '0');
    
    const dateInput = document.getElementById('attendanceDateFilter');
    if (dateInput) {
        dateInput.value = todayStr;
    }

    // Call the main filter function
    if (window.loadAttendanceByDate) {
        await window.loadAttendanceByDate();
    }
}

// 2. Filter by Date (Called by Button & LoadToday)
window.loadAttendanceByDate = async function() {
    const list = document.getElementById('attendance-list');
    const dateInput = document.getElementById('attendanceDateFilter').value;
    
    if(!dateInput) return;
    
    list.innerHTML = "<tr><td colspan='3'>Loading data...</td></tr>";

    try {
        // A. Fetch CHECK-INS
        const attendQuery = query(collection(db, "attendance"), where("date", "==", dateInput));
        const attendSnap = await getDocs(attendQuery);

        // B. Fetch APPROVED LEAVES
        const leaveQuery = query(collection(db, "leaves"), where("date", "==", dateInput), where("status", "==", "approved"));
        const leaveSnap = await getDocs(leaveQuery);

        list.innerHTML = "";
        
        if (attendSnap.empty && leaveSnap.empty) {
            list.innerHTML = "<tr><td colspan='3' style='text-align:center'>No records found for this date.</td></tr>";
            return;
        }

        // Render Check-ins
        attendSnap.forEach(doc => {
            const data = doc.data();
            const time = data.checkInTime ? data.checkInTime.toDate().toLocaleTimeString([], {hour: '2-digit', minute:'2-digit'}) : 'N/A';
            const mapLink = data.location 
                ? `<a href="https://www.google.com/maps/search/?api=1&query=${data.location.latitude},${data.location.longitude}" target="_blank">View Map 📍</a>` 
                : "No Loc";

            list.innerHTML += `
                <tr style="border-bottom:1px solid #eee;">
                    <td style="padding:10px;">${data.salesmanEmail}</td>
                    <td><span style="color:green; font-weight:bold;">Present</span></td>
                    <td>Checked In: ${time} | ${mapLink}</td>
                </tr>
            `;
        });

        // Render Leaves
        leaveSnap.forEach(doc => {
            const data = doc.data();
            const color = data.type === 'Half Day' ? '#fd7e14' : '#dc3545';
            
            list.innerHTML += `
                <tr style="border-bottom:1px solid #eee;">
                    <td style="padding:10px;">${data.salesmanEmail}</td>
                    <td><span style="color:${color}; font-weight:bold;">${data.type}</span></td>
                    <td>Remark: ${data.reason}</td>
                </tr>
            `;
        });

    } catch (error) {
        console.error("Attendance Filter Error:", error);
    }
};

// 3. Load Pending Leaves (For Approval Box)
async function loadPendingLeaves() {
    const container = document.getElementById('leave-approval-section');
    const list = document.getElementById('leave-approval-list');
    if(!container) return;

    try {
        const q = query(collection(db, "leaves"), where("status", "==", "pending"), orderBy("date", "asc"));
        const snap = await getDocs(q);

        if (snap.empty) {
            container.style.display = 'none';
            return;
        }

        container.style.display = 'block';
        list.innerHTML = "";

        snap.forEach(docSnap => {
            const data = docSnap.data();
            const row = `
                <tr>
                    <td>${data.salesmanEmail}</td>
                    <td><strong>${data.date}</strong><br>${data.type}</td>
                    <td>${data.reason}</td>
                    <td>
                        <button onclick="processLeave('${docSnap.id}', 'approved')" style="background:#28a745; color:white; border:none; padding:5px 10px; border-radius:4px; margin-right:5px; cursor:pointer;">✔</button>
                        <button onclick="processLeave('${docSnap.id}', 'rejected')" style="background:#dc3545; color:white; border:none; padding:5px 10px; border-radius:4px; cursor:pointer;">✖</button>
                    </td>
                </tr>
            `;
            list.innerHTML += row;
        });
    } catch (e) { console.error("Leave Load Error:", e); }
}

window.processLeave = async function(leaveId, status) {
    if(!confirm(`Mark request as ${status}?`)) return;
    try {
        await updateDoc(doc(db, "leaves", leaveId), { status: status });
        alert("Updated!");
        loadPendingLeaves(); // Refresh list
        loadAttendanceByDate(); // Refresh attendance table
    } catch (e) { alert("Error: " + e.message); }
};
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




// ==========================================
//      ROUTE MANAGEMENT LOGIC
// ==========================================

// Call this inside your main onAuthStateChanged/init block
// Example: 
// loadRoutes();
// populateSalesmanDropdown(); 
// populateAllOutletsDropdown();

// 1. Populate Salesman Dropdown
async function populateSalesmanDropdown() {
    const select = document.getElementById('routeSalesmanSelect');
    if (!select) return;
    
    try {
        const q = query(collection(db, "users"), where("role", "==", "salesman"));
        const snap = await getDocs(q);
        select.innerHTML = '<option value="">Select Salesman</option>';
        
        snap.forEach(doc => {
            const d = doc.data();
            const option = document.createElement('option');
            option.value = doc.id; // UID
            option.textContent = d.fullName || d.email;
            select.appendChild(option);
        });
    } catch (e) { console.error(e); }
}

// 2. Create Route
const createRouteForm = document.getElementById('createRouteForm');
if (createRouteForm) {
    createRouteForm.addEventListener('submit', async (e) => {
        e.preventDefault();
        const name = document.getElementById('routeNameInput').value;
        const salesmanId = document.getElementById('routeSalesmanSelect').value;
        const btn = e.target.querySelector('button');

        if (!name || !salesmanId) return alert("Fill all fields");

        try {
            btn.disabled = true;
            await addDoc(collection(db, "routes"), {
                name: name,
                assignedSalesmanId: salesmanId,
                createdAt: serverTimestamp(),
                active: true
            });
            alert("Route Created!");
            document.getElementById('routeNameInput').value = "";
            loadRoutes(); // Refresh list
        } catch (error) {
            alert("Error: " + error.message);
        } finally {
            btn.disabled = false;
        }
    });
}

// 3. Load Existing Routes
async function loadRoutes() {
    const list = document.getElementById('routes-list-group');
    if (!list) return;

    try {
        const q = query(collection(db, "routes"), orderBy("createdAt", "desc"));
        const snap = await getDocs(q);
        list.innerHTML = "";

        if (snap.empty) { list.innerHTML = "<li>No routes found.</li>"; return; }

        snap.forEach(docSnap => {
            const data = docSnap.data();
            const li = document.createElement('li');
            li.style.padding = "10px";
            li.style.borderBottom = "1px solid #eee";
            li.style.cursor = "pointer";
            li.style.display = "flex";
            li.style.justifyContent = "space-between";
            li.innerHTML = `
                <span>
                    <strong>${data.name}</strong><br>
                    <small style="color:#666">Salesman ID: ${data.assignedSalesmanId.slice(0,5)}...</small>
                </span>
                <button onclick="selectRoute('${docSnap.id}', '${data.name}')" style="font-size:0.8rem;">Config</button>
            `;
            list.appendChild(li);
        });
    } catch (e) { console.error(e); }
}

// 4. Populate All Outlets (for adding to route)
async function populateAllOutletsDropdown() {
    const select = document.getElementById('allOutletsDropdown');
    if (!select) return;

    try {
        const snap = await getDocs(collection(db, "outlets"));
        select.innerHTML = '<option value="">Select Outlet to Add</option>';
        snap.forEach(doc => {
            const d = doc.data();
            const option = document.createElement('option');
            option.value = doc.id;
            option.textContent = `${d.shopName} (${d.contactPhone})`;
            // Store name in dataset to avoid extra fetching later
            option.dataset.name = d.shopName; 
            select.appendChild(option);
        });
    } catch (e) { console.error(e); }
}

// 5. Select Route (Setup UI)
window.selectRoute = function(routeId, routeName) {
    document.getElementById('selectedRouteId').value = routeId;
    document.getElementById('selectedRouteName').innerText = routeName;
    document.getElementById('routeConfigPanel').style.display = 'block';
    document.getElementById('routeConfigMsg').style.display = 'none';
    
    loadRouteOutlets(routeId);
};

// 6. Load Outlets Attached to Route
async function loadRouteOutlets(routeId) {
    const tbody = document.getElementById('route-outlets-list');
    tbody.innerHTML = '<tr><td colspan="3">Loading...</td></tr>';

    try {
        const q = query(
            collection(db, "route_outlets"), 
            where("routeId", "==", routeId),
            orderBy("sequence", "asc")
        );
        const snap = await getDocs(q);
        
        tbody.innerHTML = "";
        if (snap.empty) { tbody.innerHTML = '<tr><td colspan="3">No outlets in this route.</td></tr>'; return; }

        snap.forEach(docSnap => {
            const d = docSnap.data();
            tbody.innerHTML += `
                <tr>
                    <td>${d.sequence}</td>
                    <td>${d.outletName}</td>
                    <td>
                        <button onclick="changeSequence('${docSnap.id}', -1, ${d.sequence})" style="padding:2px 5px;">⬆</button>
                        <button onclick="changeSequence('${docSnap.id}', 1, ${d.sequence})" style="padding:2px 5px;">⬇</button>
                        <button onclick="removeOutletFromRoute('${docSnap.id}')" style="color:red; margin-left:5px;">X</button>
                    </td>
                </tr>
            `;
        });
    } catch (e) { 
        console.error(e); 
        tbody.innerHTML = '<tr><td colspan="3">Error (Check Console for Index).</td></tr>';
    }
}

// 7. Add Outlet to Route
window.addOutletToRoute = async function() {
    const routeId = document.getElementById('selectedRouteId').value;
    const select = document.getElementById('allOutletsDropdown');
    const outletId = select.value;
    const outletName = select.options[select.selectedIndex].dataset.name;

    if (!routeId || !outletId) return alert("Select a route and an outlet.");

    try {
        // Find current max sequence
        const q = query(collection(db, "route_outlets"), where("routeId", "==", routeId));
        const snap = await getDocs(q);
        const nextSeq = snap.size + 1;

        // Add doc
        await addDoc(collection(db, "route_outlets"), {
            routeId: routeId,
            outletId: outletId,
            outletName: outletName, // Denormalized for display
            sequence: nextSeq
        });

        loadRouteOutlets(routeId); // Refresh
    } catch (e) {
        console.error(e);
        alert("Error adding outlet.");
    }
};

// 8. Remove Outlet
window.removeOutletFromRoute = async function(docId) {
    if(!confirm("Remove from route?")) return;
    try {
        await deleteDoc(doc(db, "route_outlets", docId));
        // Note: Real apps should re-calculate sequences here, 
        // but for simplicity we skip re-indexing remaining items.
        loadRouteOutlets(document.getElementById('selectedRouteId').value);
    } catch (e) { console.error(e); }
};

// 9. Reorder (Swap) Logic
window.changeSequence = async function(docId, direction, currentSeq) {
    // direction: -1 (Up), 1 (Down)
    const newSeq = currentSeq + direction;
    if (newSeq < 1) return; // Can't go below 1

    const routeId = document.getElementById('selectedRouteId').value;

    try {
        // Find the neighbor to swap with
        const q = query(
            collection(db, "route_outlets"), 
            where("routeId", "==", routeId),
            where("sequence", "==", newSeq)
        );
        const neighborSnap = await getDocs(q);

        if (!neighborSnap.empty) {
            // Update neighbor
            const neighborDoc = neighborSnap.docs[0];
            await updateDoc(doc(db, "route_outlets", neighborDoc.id), { sequence: currentSeq });
        }

        // Update current
        await updateDoc(doc(db, "route_outlets", docId), { sequence: newSeq });

        loadRouteOutlets(routeId);

    } catch (e) {
        console.error("Reorder error:", e);
        // This query requires a composite index: routeId ASC, sequence ASC
        if(e.message.includes("index")) alert("Index missing. Check console.");
    }
};

// ==========================================
//      PRODUCT MANAGEMENT LOGIC
// ==========================================

function setupProductForm() {
    const form = document.getElementById('addProductForm');
    if (!form) return;

    form.addEventListener('submit', async (e) => {
        e.preventDefault();
        const btn = e.target.querySelector('button');
        btn.innerText = "Saving...";
        btn.disabled = true;

        try {
            await addDoc(collection(db, "products"), {
                name: document.getElementById('prodName').value.trim(),
                category: document.getElementById('prodCategory').value.trim(),
                hsn: document.getElementById('prodHSN').value.trim() || "N/A",
                price: Number(document.getElementById('prodPrice').value),
                createdAt: serverTimestamp(),
                isActive: true
            });

            alert("Product Added!");
            form.reset();
            loadProducts(); // Refresh list

        } catch (error) {
            console.error(error);
            alert("Error adding product: " + error.message);
        } finally {
            btn.innerText = "Add Product";
            btn.disabled = false;
        }
    });
}

async function loadProducts() {
    const tbody = document.getElementById('product-list-body');
    if (!tbody) return;

    try {
        const q = query(collection(db, "products"), orderBy("createdAt", "desc"));
        const snap = await getDocs(q);

        tbody.innerHTML = "";
        if (snap.empty) {
            tbody.innerHTML = "<tr><td colspan='5'>No products found.</td></tr>";
            return;
        }

        snap.forEach(docSnap => {
            const d = docSnap.data();
            const row = `
                <tr>
                    <td><strong>${d.name}</strong></td>
                    <td>${d.category}</td>
                    <td>${d.hsn}</td>
                    <td>₹${d.price.toFixed(2)}</td>
                    <td>
                        <button onclick="deleteProduct('${docSnap.id}')" style="color:red; border:none; background:none; cursor:pointer;">🗑️</button>
                    </td>
                </tr>
            `;
            tbody.innerHTML += row;
        });

    } catch (error) {
        console.error("Load Products Error:", error);
        if(error.message.includes("index")) {
            // Fallback if index missing
             tbody.innerHTML = "<tr><td colspan='5' style='color:red'>Missing Index (See Console)</td></tr>";
        }
    }
}

// Global Delete Function
window.deleteProduct = async function(id) {
    if(!confirm("Delete this product?")) return;
    try {
        await deleteDoc(doc(db, "products", id));
        loadProducts();
    } catch (e) { alert("Error deleting: " + e.message); }
};
// --- UTILITY (WAS MISSING) ---
function formatCurrency(amount) {
    return new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD' }).format(amount);
}



// ==========================================
//      PAYMENT APPROVAL & TRANSACTION LOGIC
// ==========================================

// 1. Function to Load the List (Must exist for the dashboard to show alerts)
async function loadPendingPayments() {
    console.log("Checking for pending payments...");
    const container = document.getElementById('approval-section');
    const list = document.getElementById('approval-list');

    if(!container) return;

    try {
        // Query: Status is 'pending', ordered by newest first
        const q = query(
            collection(db, "payments"), 
            where("status", "==", "pending"),
            orderBy("date", "desc")
        );
        
        const snap = await getDocs(q);

        if (snap.empty) {
            container.style.display = 'none';
            return;
        }

        container.style.display = 'block';
        list.innerHTML = "";

        snap.forEach(docSnap => {
            const data = docSnap.data();
            const isOffsite = data.collectedWithoutVisit ? 
    `<span style="color:red; font-size:10px;">[OFF-SITE]</span>` : 
    `<span style="color:blue; font-size:10px;">[ON-VISIT]</span>`;

const mapLink = `https://www.google.com/maps/search/?api=1&query=${data.gpsLat},${data.gpsLng}`;

const row = `
    <tr>
        <td>
            <strong>${data.outletName}</strong> ${isOffsite}<br>
            <small>By: ${data.salesmanId ? data.salesmanId.slice(0,5) : 'Unknown'}</small>
        </td>
        <td style="font-weight:bold; color:green;">₹${data.amount}</td>
        <td>
            ${data.method}<br>
            <a href="${mapLink}" target="_blank" style="color:blue; text-decoration:underline; font-size:10px;">View GPS 📍</a>
        </td>
        <td>
            <button onclick="processPayment('${docSnap.id}', '${data.outletId}', ${data.amount}, 'approve')" ...>✔</button>
            <button onclick="processPayment('${docSnap.id}', '${data.outletId}', ${data.amount}, 'reject')" ...>✖</button>
        </td>
    </tr>
`;
            list.innerHTML += row;
        });

    } catch (error) {
        console.error("Approval Load Error:", error);
        if(error.message.includes("index")) {
            container.style.display = 'block';
            list.innerHTML = `<tr><td colspan="4" style="color:red; font-weight:bold;">⚠️ Missing Index. Check Console.</td></tr>`;
        }
    }
}

// 2. Global Function to Handle Click (Must match what is in HTML)
window.processPayment = async function(paymentId, outletId, amount, action) {
    console.log(`Processing payment: ${paymentId}, Action: ${action}`);

    const reason = action === 'reject' ? prompt("Enter rejection reason:") : "Approved";
    if (action === 'reject' && !reason) return; 

    if(!paymentId || !outletId || !amount) {
        alert("Error: Missing payment details.");
        return;
    }

    try {
        await runTransaction(db, async (transaction) => {
            const payRef = doc(db, "payments", paymentId);
            const outletRef = doc(db, "outlets", outletId);

            const payDoc = await transaction.get(payRef);
            const outletDoc = await transaction.get(outletRef);

            if (!payDoc.exists()) throw "Payment record missing!";
            if (payDoc.data().status !== 'pending') throw "Already processed.";

            if (action === 'approve') {
                if (!outletDoc.exists()) throw "Outlet not found.";
                
                // Deduct Balance
                const currentBal = Number(outletDoc.data().currentBalance) || 0;
                const newBal = currentBal - Number(amount);

                transaction.update(outletRef, { 
                    currentBalance: newBal,
                    lastPaymentDate: serverTimestamp()
                });

                transaction.update(payRef, { 
                    status: 'approved',
                    adminNote: reason,
                    processedAt: serverTimestamp()
                });
            } else {
                // Reject
                transaction.update(payRef, { 
                    status: 'rejected',
                    adminNote: reason,
                    processedAt: serverTimestamp()
                });
            }
        });

        alert(`Payment ${action}ed successfully.`);
        
        // REFRESH THE UI
        loadPendingPayments(); // This refreshes the list (removing the button)
        loadDashboardStats();  // This updates the total credit stats
        
        if(typeof loadOutlets === 'function') loadOutlets(); // Refresh outlet table if visible

    } catch (error) {
        console.error("Transaction Error:", error);
        alert("Failed: " + error);
    }
};




// ==========================================
//      LEAVE MANAGEMENT LOGIC
// ==========================================

window.loadPendingLeaves = async function () {
    const container = document.getElementById('leave-approval-section');
    const list = document.getElementById('leave-approval-list');
    if(!container) return;

    try {
        const q = query(collection(db, "leaves"), where("status", "==", "pending"), orderBy("date", "asc"));
        const snap = await getDocs(q);

        if (snap.empty) {
            container.style.display = 'none';
            return;
        }

        container.style.display = 'block';
        list.innerHTML = "";

        snap.forEach(docSnap => {
            const data = docSnap.data();
            const row = `
                <tr>
                    <td>${data.salesmanEmail}</td>
                    <td><strong>${data.date}</strong><br>${data.type}</td>
                    <td>${data.reason}</td>
                    <td>
                        <button onclick="processLeave('${docSnap.id}', 'approved')" style="background:#28a745; color:white; border:none; padding:5px 10px; border-radius:4px; margin-right:5px; cursor:pointer;">✔</button>
                        <button onclick="processLeave('${docSnap.id}', 'rejected')" style="background:#dc3545; color:white; border:none; padding:5px 10px; border-radius:4px; cursor:pointer;">✖</button>
                    </td>
                </tr>
            `;
            list.innerHTML += row;
        });
    } catch (e) { console.error("Leave Load Error:", e); }
}

window.processLeave = async function(leaveId, status) {
    if(!confirm(`Mark request as ${status}?`)) return;
    try {
        await updateDoc(doc(db, "leaves", leaveId), { status: status });
        alert("Updated!");
        loadPendingLeaves(); // Refresh list
        loadAttendanceByDate(); // Refresh attendance table if date matches
    } catch (e) { alert("Error: " + e.message); }
};

// ==========================================
//      DATE-WISE ATTENDANCE LOGIC
// ==========================================

// Replace your old loadTodayAttendance with this enhanced version
window.loadAttendanceByDate = async function() {
    const list = document.getElementById('attendance-list');
    const dateInput = document.getElementById('attendanceDateFilter').value;
    
    if(!dateInput) return alert("Select a date");
    
    list.innerHTML = "<tr><td colspan='3'>Loading data...</td></tr>";

    try {
        // 1. Fetch CHECK-INS for this date
        // Note: Make sure 'date' field in attendance collection is 'YYYY-MM-DD' string
        const attendQuery = query(collection(db, "attendance"), where("date", "==", dateInput));
        const attendSnap = await getDocs(attendQuery);

        // 2. Fetch APPROVED LEAVES for this date
        const leaveQuery = query(collection(db, "leaves"), where("date", "==", dateInput), where("status", "==", "approved"));
        const leaveSnap = await getDocs(leaveQuery);

        list.innerHTML = "";
        
        if (attendSnap.empty && leaveSnap.empty) {
            list.innerHTML = "<tr><td colspan='3' style='text-align:center'>No records found for this date.</td></tr>";
            return;
        }

        // Render Check-ins
        attendSnap.forEach(doc => {
            const data = doc.data();
            const time = data.checkInTime ? data.checkInTime.toDate().toLocaleTimeString([], {hour: '2-digit', minute:'2-digit'}) : 'N/A';
            const mapLink = data.location 
                ? `<a href="https://www.google.com/maps/search/?api=1&query=${data.location.latitude},${data.location.longitude}" target="_blank">View Map 📍</a>` 
                : "No Loc";

            list.innerHTML += `
                <tr>
                    <td>${data.salesmanEmail}</td>
                    <td><span style="color:green; font-weight:bold;">Present</span></td>
                    <td>Checked In: ${time} | ${mapLink}</td>
                </tr>
            `;
        });

        // Render Leaves
        leaveSnap.forEach(doc => {
            const data = doc.data();
            const color = data.type === 'Half Day' ? '#fd7e14' : '#dc3545'; // Orange or Red
            
            list.innerHTML += `
                <tr>
                    <td>${data.salesmanEmail}</td>
                    <td><span style="color:${color}; font-weight:bold;">${data.type}</span></td>
                    <td>Remark: ${data.reason}</td>
                </tr>
            `;
        });

    } catch (error) {
        console.error("Attendance Filter Error:", error);
        if(error.message.includes("index")) {
            list.innerHTML = "<tr><td colspan='3' style='color:red'>Missing Index. Check Console.</td></tr>";
        }
    }
};

// Also call this initially to load today's data
// loadAttendanceByDate(); (This is called in init via the button click simulation or explicit call)



// 1. Add to the salesman list loading part to also populate the target dropdown
async function populateTargetSalesmanDropdown() {
    const select = document.getElementById('targetSalesmanId');
    if(!select) return;
    
    const q = query(collection(db, "users"), where("role", "==", "salesman"));
    const snap = await getDocs(q);
    
    snap.forEach(doc => {
        const d = doc.data();
        const opt = document.createElement('option');
        opt.value = doc.id;
        opt.textContent = d.fullName || d.email;
        select.appendChild(opt);
    });
}

// 2. Add the form submit listener
const targetForm = document.getElementById('targetForm');
if(targetForm) {
    targetForm.addEventListener('submit', async (e) => {
        e.preventDefault();
        const btn = e.target.querySelector('button');
        
        try {
            btn.disabled = true;
            btn.innerText = "Saving...";

            await addDoc(collection(db, "daily_targets"), {
                salesmanId: document.getElementById('targetSalesmanId').value,
                date: document.getElementById('targetDate').value, // YYYY-MM-DD
                targetBoxes: Number(document.getElementById('targetBoxes').value),
                incentivePerBox: Number(document.getElementById('incentivePerBox').value),
                createdBy: auth.currentUser.uid,
                createdAt: serverTimestamp()
            });

            alert("Target assigned successfully!");
            targetForm.reset();
        } catch (error) {
            console.error(error);
            alert("Error: " + error.message);
        } finally {
            btn.disabled = false;
            btn.innerText = "Set Target";
        }
    });
}

// Ensure populateTargetSalesmanDropdown() is called in your admin init block










// --- TARGET MANAGEMENT LOGIC ---

// 1. Populate the target dropdown (Reuse existing user query or fetch new)
async function populateTargetSalesmanDropdown() {
    const select = document.getElementById('targetSalesmanId');
    if(!select) return;
    
    // Clear existing options except first
    select.innerHTML = '<option value="">Select Staff...</option>';

    try {
        const q = query(collection(db, "users"), where("role", "==", "salesman"));
        const snap = await getDocs(q);
        
        snap.forEach(doc => {
            const d = doc.data();
            const opt = document.createElement('option');
            opt.value = doc.id;
            opt.textContent = d.fullName || d.email;
            select.appendChild(opt);
        });
        
        // Set default date to today
        document.getElementById('targetDate').valueAsDate = new Date();

    } catch (e) { console.error("Target Dropdown Error:", e); }
}

// 2. Handle Form Submit
const targetForm = document.getElementById('targetForm');
if(targetForm) {
    targetForm.addEventListener('submit', async (e) => {
        e.preventDefault();
        const btn = targetForm.querySelector('button');
        const originalText = btn.innerText;

        try {
            btn.disabled = true;
            btn.innerText = "Saving...";

            const salesmanId = document.getElementById('targetSalesmanId').value;
            const date = document.getElementById('targetDate').value; // YYYY-MM-DD
            
            // Create a unique ID for the doc so we can overwrite if target exists for same day/user
            const targetId = `${salesmanId}_${date}`; 

            await setDoc(doc(db, "daily_targets", targetId), {
                salesmanId: salesmanId,
                date: date,
                targetBoxes: Number(document.getElementById('targetBoxes').value),
                incentivePerBox: Number(document.getElementById('incentivePerBox').value),
                updatedAt: serverTimestamp()
            });

            alert("✅ Target Assigned Successfully!");
            targetForm.reset();
            document.getElementById('targetDate').valueAsDate = new Date(); // Reset date to today
            populateTargetSalesmanDropdown(); // Refresh dropdown if needed

        } catch (error) {
            console.error(error);
            alert("Error: " + error.message);
        } finally {
            btn.disabled = false;
            btn.innerText = originalText;
        }
    });
}

// IMPORTANT: Add 'populateTargetSalesmanDropdown()' to your main onAuthStateChanged success block
// alongside loadDashboardStats(), loadOutlets(), etc.
// Add 'setDoc' to your imports from firebase-firestore.js at the top of the file.
