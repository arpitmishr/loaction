// js/admin.js

// 1. IMPORTS

import { 
    // ... existing imports ...
    deleteDoc 
} from "https://www.gstatic.com/firebasejs/11.2.0/firebase-firestore.js";

import { onAuthStateChanged } from "https://www.gstatic.com/firebasejs/11.2.0/firebase-auth.js";
import { 
    doc, getDoc, collection, getDocs, query, where, Timestamp, 
    addDoc, updateDoc, serverTimestamp, runTransaction, orderBy, setDoc, writeBatch, limit, startAfter   
} from "https://www.gstatic.com/firebasejs/11.2.0/firebase-firestore.js";
import { auth, db } from "./firebase.js";
import { logoutUser } from "./auth.js";
import { getCachedUserProfile } from "./auth.js"; // <--- Add this import at the top
const content = document.getElementById('content');
const loader = document.getElementById('loader');


// --- 2. MAIN EXECUTION ---
onAuthStateChanged(auth, async (user) => {
    if (!user) {
        window.location.href = 'index.html';
        return;
    }

    try {
        // A. USE CACHED PROFILE (No more getDoc here)
        const userData = await getCachedUserProfile(user.uid);
        
        // B. Check Admin Role
        if (!userData || userData.role !== 'admin') {
            alert("Access Denied: Admins Only.");
            await logoutUser();
            return;
        }

        // C. SUCCESS: Update UI
        if (loader) loader.style.display = 'none';
        if (content) content.style.display = 'block';
        
        if(document.getElementById('user-email')) {
            document.getElementById('user-email').innerText = user.email;
        }

        // ... rest of your loading functions (setupOutletForm, loadDashboardStats, etc.) ...
        setupOutletForm();
        loadDashboardStats();
        loadTodayAttendance();
        loadOutlets(); 
        loadSalesmenList();
        populateTargetSalesmanDropdown();
        setupTransactionTab();
        loadRoutes();
        populateSalesmanDropdown();
        populateAllOutletsDropdown();
        loadProducts();
        setupProductForm();
        loadPendingPayments();
        loadPendingLeaves();
        document.getElementById('attendanceDateFilter').valueAsDate = new Date();

    } catch (error) {
        console.error("Dashboard Init Error:", error);
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
// --- LOAD PENDING LEAVES (LIMITED) ---
async function loadPendingLeaves() {
    const container = document.getElementById('leave-approval-section');
    const list = document.getElementById('leave-approval-list');
    if(!container) return;

    try {
        // OPTIMIZATION: Limit to 20
        const q = query(
            collection(db, "leaves"), 
            where("status", "==", "pending"), 
            orderBy("date", "asc"),
            limit(20)
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
            const name = data.salesmanName || data.salesmanEmail;
            
            const row = `
                <tr>
                    <td>${name}</td>
                    <td><strong>${data.date}</strong><br>${data.type}</td>
                    <td>${data.reason}</td>
                    <td>
                        <button onclick="processLeave('${docSnap.id}', 'approved')" style="color:green; margin-right:5px;">✔</button>
                        <button onclick="processLeave('${docSnap.id}', 'rejected')" style="color:red;">✖</button>
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











// --- LOAD SALESMEN (LIMITED) ---
async function loadSalesmenList() {
    const list = document.getElementById('salesmen-list');
    if(!list) return;
    list.innerHTML = '<li>Loading...</li>';

    try {
        // OPTIMIZATION: Limit to 20
        const q = query(
            collection(db, "users"), 
            where("role", "==", "salesman"),
            limit(20)
        );
        const snap = await getDocs(q);
        
        list.innerHTML = "";
        if(snap.empty) { list.innerHTML = "<li>No active salesmen found.</li>"; return; }

        snap.forEach(doc => {
            const d = doc.data();
            // Use Denormalized ID/Name if you want, but this is the 'users' collection so it's source data
            const li = document.createElement('li');
            li.className = "flex justify-between items-center p-3 bg-slate-50 rounded-xl hover:bg-white border border-slate-100 shadow-sm transition-all";
            
            li.innerHTML = `
                <div class="flex items-center gap-3">
                    <div class="bg-indigo-100 text-indigo-600 p-2 rounded-full">
                        <span class="material-icons-round text-sm">person</span>
                    </div>
                    <div>
                        <p class="text-sm font-bold text-slate-700">${d.fullName || d.email}</p>
                        <p class="text-xs text-slate-400">${d.phone || 'No Phone'}</p>
                    </div>
                </div>
                <button onclick="openSalarySettings('${doc.id}', '${d.fullName || d.email}')" class="text-slate-400 hover:text-emerald-600 p-2 rounded-lg hover:bg-emerald-50 transition">
                    <span class="material-icons-round text-lg">payments</span>
                </button>
            `;
            list.appendChild(li);
        });

    } catch (error) {
        console.error("Error loading salesmen:", error);
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

// --- LOAD OUTLETS (LIMITED) ---
// --- LOAD OUTLETS (UPDATED WITH DELETE & BLOCK) ---
async function loadOutlets() {
    const tableBody = document.getElementById('outlets-table-body');
    if (!tableBody) return;
    
    try {
        const q = query(
            collection(db, "outlets"), 
            orderBy("createdAt", "desc"), 
            limit(50) // Increased limit to see more
        );
        const snap = await getDocs(q);

        tableBody.innerHTML = "";
        if (snap.empty) { tableBody.innerHTML = "<tr><td colspan='6' class='p-4 text-center text-slate-400'>No outlets found.</td></tr>"; return; }

        snap.forEach(docSnap => {
            const data = docSnap.data();
            const id = docSnap.id;
            const isBlocked = data.status === 'blocked';
            
            // Status Badge
            const statusBadge = isBlocked 
                ? `<span class="bg-red-100 text-red-700 px-2 py-1 rounded-full text-[10px] font-bold uppercase tracking-wide">Blocked</span>` 
                : `<span class="bg-emerald-100 text-emerald-700 px-2 py-1 rounded-full text-[10px] font-bold uppercase tracking-wide">Active</span>`;

            // Block/Unblock Button
            const blockBtn = isBlocked
                ? `<button onclick="toggleOutletStatus('${id}', 'active')" class="text-emerald-600 hover:bg-emerald-50 p-2 rounded-lg transition-colors" title="Unblock Outlet">
                     <svg xmlns="http://www.w3.org/2000/svg" class="h-5 w-5" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M9 12l2 2 4-4m6 2a9 9 0 11-18 0 9 9 0 0118 0z" /></svg>
                   </button>`
                : `<button onclick="toggleOutletStatus('${id}', 'blocked')" class="text-amber-500 hover:bg-amber-50 p-2 rounded-lg transition-colors" title="Block Outlet">
                     <svg xmlns="http://www.w3.org/2000/svg" class="h-5 w-5" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M18.364 18.364A9 9 0 005.636 5.636m12.728 12.728A9 9 0 015.636 5.636m12.728 12.728L5.636 5.636" /></svg>
                   </button>`;

            // Edit Button
            const editBtn = `<button onclick="editOutlet('${id}')" class="text-blue-500 hover:bg-blue-50 p-2 rounded-lg transition-colors" title="Edit Details">
                                <svg xmlns="http://www.w3.org/2000/svg" class="h-5 w-5" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M11 5H6a2 2 0 00-2 2v11a2 2 0 002 2h11a2 2 0 002-2v-5m-1.414-9.414a2 2 0 112.828 2.828L11.828 15H9v-2.828l8.586-8.586z" /></svg>
                             </button>`;

            // DELETE BUTTON (NEW)
            const deleteBtn = `<button onclick="deleteOutlet('${id}', '${data.shopName}')" class="text-red-500 hover:bg-red-50 p-2 rounded-lg transition-colors" title="Delete Permanently">
                                 <svg xmlns="http://www.w3.org/2000/svg" class="h-5 w-5" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16" /></svg>
                               </button>`;

            const creditInfo = data.storeType === 'Credit' 
                ? `<span class="text-xs font-bold text-pink-500">Limit: ₹${data.creditLimit}</span>` 
                : `<span class="text-xs font-bold text-emerald-600">Cash</span>`;

            // Row HTML
            const row = `
                <tr class="hover:bg-slate-50 border-b border-slate-50 transition-colors ${isBlocked ? 'bg-red-50/30' : ''}">
                    <td class="p-4">
                        <div class="font-bold text-slate-800">${data.shopName}</div>
                        <div class="text-xs text-slate-500">${data.outletType}</div>
                    </td>
                    <td class="p-4">
                        <div class="text-sm text-slate-700">${data.contactPerson}</div>
                        <a href="tel:${data.contactPhone}" class="text-xs text-blue-500 hover:underline">${data.contactPhone}</a>
                    </td>
                    <td class="p-4">
                        <div class="text-sm font-medium text-slate-700">${data.storeType}</div>
                        ${creditInfo}
                    </td>
                    <td class="p-4 text-center">${statusBadge}</td>
                    <td class="p-4">
                        <div class="flex items-center justify-end gap-1">
                            ${blockBtn}
                            ${editBtn}
                            ${deleteBtn}
                        </div>
                    </td>
                </tr>`;
            tableBody.innerHTML += row;
        });
        
    } catch (error) {
        console.error("Load Outlets Error:", error);
    }
}











// --- BLOCK/UNBLOCK LOGIC ---
window.toggleOutletStatus = async function(id, newStatus) {
    const action = newStatus === 'blocked' ? 'Block' : 'Activate';
    if(!confirm(`Are you sure you want to ${action} this outlet?`)) return;

    try {
        await updateDoc(doc(db, "outlets", id), { status: newStatus });
        
        // If blocking, visual feedback is enough, reload table
        loadOutlets();
    } catch (error) {
        console.error("Status Update Error:", error);
        alert("Failed to update status.");
    }
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
            const id = docSnap.id;
            const isSleep = data.status === 'sleep';
            
            const li = document.createElement('li');
            li.className = `p-4 border-b border-slate-100 transition-colors ${isSleep ? 'bg-slate-50 opacity-75' : 'bg-white'}`;
            
            li.innerHTML = `
                <div class="flex justify-between items-start mb-2">
                    <div onclick="selectRoute('${id}', '${data.name}')" class="cursor-pointer">
                        <strong class="text-slate-800">${data.name}</strong>
                        <div class="text-[10px] ${isSleep ? 'text-red-500' : 'text-green-500'} font-bold uppercase">
                            ${isSleep ? '● Sleep Mode' : '● Active'}
                        </div>
                    </div>
                    <div class="flex gap-2">
                        <button onclick="toggleRouteStatus('${id}', '${isSleep ? 'active' : 'sleep'}')" 
                                class="p-1.5 rounded-lg border border-slate-200 hover:bg-slate-100" title="Toggle Sleep/Active">
                            <span class="material-icons-round text-sm">${isSleep ? 'play_arrow' : 'pause'}</span>
                        </button>
                        <button onclick="selectRoute('${id}', '${data.name}')" class="p-1.5 bg-indigo-50 text-indigo-600 rounded-lg">
                            <span class="material-icons-round text-sm">settings</span>
                        </button>
                    </div>
                </div>
                
                <div class="space-y-2 mt-3">
                    <label class="text-[9px] font-bold text-slate-400 uppercase">Assigned To</label>
                    <select onchange="changeRouteSalesman('${id}', this.value)" class="w-full text-xs p-1.5 bg-white border border-slate-200 rounded-md">
                        ${generateSalesmanOptions(data.assignedSalesmanId)}
                    </select>
                </div>

                <div class="mt-2 text-[10px] text-slate-500">
                    Last Route Activity: <span class="font-bold text-slate-700">${data.lastVisitDate || 'Never'}</span>
                </div>
            `;
            list.appendChild(li);
        });
    } catch (e) { console.error(e); }
}


function generateSalesmanOptions(currentId) {
    // This assumes you have global salesman data or we fetch it
    let options = `<option value="">Unassigned</option>`;
    const select = document.getElementById('routeSalesmanSelect'); // borrowing from your existing dropdown
    if(select) {
        Array.from(select.options).forEach(opt => {
            if(!opt.value) return;
            options += `<option value="${opt.value}" ${opt.value === currentId ? 'selected' : ''}>${opt.text}</option>`;
        });
    }
    return options;
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

// --- LOAD PRODUCTS (LIMITED) ---
async function loadProducts() {
    const tbody = document.getElementById('product-list-body');
    if (!tbody) return;

    try {
        // OPTIMIZATION: Limit to 20
        const q = query(
            collection(db, "products"), 
            orderBy("createdAt", "desc"), 
            limit(20)
        );
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
    return new Intl.NumberFormat('en-IN', {
        style: 'currency',
        currency: 'INR',
        maximumFractionDigits: 2
    }).format(amount);
}




// ==========================================
//      PAYMENT APPROVAL & TRANSACTION LOGIC
// ==========================================

// --- LOAD PENDING PAYMENTS (LIMITED) ---
async function loadPendingPayments() {
    const container = document.getElementById('approval-section');
    const list = document.getElementById('approval-list');

    if(!container) return;

    try {
        // OPTIMIZATION: Limit to 20
        const q = query(
            collection(db, "payments"), 
            where("status", "==", "pending"),
            orderBy("date", "desc"),
            limit(20) 
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
            
            // Use Denormalized Names if available, fallback to IDs
            const shopName = data.outletName || data.outletId;
            const staffName = data.salesmanName || (data.salesmanId ? data.salesmanId.slice(0,5) : 'Unknown');
            
            const mapLink = `https://www.google.com/maps/search/?api=1&query=${data.gpsLat},${data.gpsLng}`;

            const row = `
                <tr>
                    <td>
                        <strong>${shopName}</strong> ${isOffsite}<br>
                        <small>By: ${staffName}</small>
                    </td>
                    <td style="font-weight:bold; color:green;">₹${data.amount}</td>
                    <td>
                        ${data.method}<br>
                        <a href="${mapLink}" target="_blank" style="color:blue; text-decoration:underline; font-size:10px;">View GPS 📍</a>
                    </td>
                    <td>
                        <button onclick="processPayment('${docSnap.id}', '${data.outletId}', ${data.amount}, 'approve')" style="cursor:pointer; margin-right:5px;">✔</button>
                        <button onclick="processPayment('${docSnap.id}', '${data.outletId}', ${data.amount}, 'reject')" style="cursor:pointer;">✖</button>
                    </td>
                </tr>
            `;
            list.innerHTML += row;
        });

    } catch (error) {
        console.error("Approval Load Error:", error);
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













// ==========================================
//      DAILY TARGET LOGIC (FINAL VERSION)
// ==========================================

async function populateTargetSalesmanDropdown() {
    const select = document.getElementById('targetSalesmanId');
    if(!select) return;
    
    // Reset options
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
        
        // Auto-set date to today
        const today = new Date();
        const yyyy = today.getFullYear();
        const mm = String(today.getMonth() + 1).padStart(2, '0');
        const dd = String(today.getDate()).padStart(2, '0');
        
        const dateInput = document.getElementById('targetDate');
        if(dateInput) dateInput.value = `${yyyy}-${mm}-${dd}`;

    } catch (e) { console.error("Target Dropdown Error:", e); }
}

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
            
            // Unique ID: salesmanID_YYYY-MM-DD
            const targetId = `${salesmanId}_${date}`; 

            // Use setDoc to allow updating existing targets
            await setDoc(doc(db, "daily_targets", targetId), {
                salesmanId: salesmanId,
                date: date,
                targetBoxes: Number(document.getElementById('targetBoxes').value),
                incentivePerBox: Number(document.getElementById('incentivePerBox').value),
                assignedBy: auth.currentUser.uid,
                updatedAt: serverTimestamp()
            });

            alert("✅ Target Assigned Successfully!");
            
            // Clear values but keep date/salesman selected for convenience
            document.getElementById('targetBoxes').value = "";
            document.getElementById('incentivePerBox').value = "";

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




// ==========================================
//      MONTHLY ATTENDANCE SHEET LOGIC
// ==========================================

// 1. Initialize Month Picker to Current Month
const sheetPicker = document.getElementById('sheetMonthPicker');
if(sheetPicker) {
    const today = new Date();
    const yyyy = today.getFullYear();
    const mm = String(today.getMonth() + 1).padStart(2, '0');
    sheetPicker.value = `${yyyy}-${mm}`;
}

// 2. Main Function to Load and Render the Sheet
async function loadAttendanceSheet() {
    const picker = document.getElementById('sheetMonthPicker');
    const tbody = document.getElementById('sheet-body');
    const theadRow = document.getElementById('sheet-header-row');
    
    if(!picker || !picker.value) return alert("Select a month");
    
    tbody.innerHTML = '<tr><td colspan="32" class="p-6 text-center">Generating Matrix...</td></tr>';
    
    const [year, month] = picker.value.split('-');
    const daysInMonth = new Date(year, month, 0).getDate();
    
    // --- A. Build Table Header (Days) ---
    let headerHTML = `<th class="p-3 border-b border-r border-slate-200 sticky left-0 bg-slate-50 z-20 shadow-sm text-left">Staff Name</th>`;
    for(let i = 1; i <= daysInMonth; i++) {
        const dateObj = new Date(year, month - 1, i);
        const dayName = dateObj.toLocaleDateString('en-US', { weekday: 'narrow' }); // M, T, W...
        const isWeekend = (dateObj.getDay() === 0); // Sunday
        
        headerHTML += `
            <th class="p-1 border-b border-slate-100 text-center min-w-[35px] ${isWeekend ? 'bg-red-50 text-red-400' : ''}">
                <div class="text-[10px]">${dayName}</div>
                <div>${i}</div>
            </th>
        `;
    }
    theadRow.innerHTML = headerHTML;

    try {
        // --- B. Fetch Data ---
        // 1. Get all Salesmen
        const usersQ = query(collection(db, "users"), where("role", "==", "salesman"));
        const usersSnap = await getDocs(usersQ);
        
        if(usersSnap.empty) {
            tbody.innerHTML = '<tr><td colspan="32" class="p-6 text-center">No salesmen found.</td></tr>';
            return;
        }

        // 2. Get Attendance for this Month (String comparison works for YYYY-MM-DD)
        const startStr = `${year}-${month}-01`;
        const endStr = `${year}-${month}-${daysInMonth}`;
        
        const attendQ = query(collection(db, "attendance"), 
            where("date", ">=", startStr), 
            where("date", "<=", endStr)
        );
        const attendSnap = await getDocs(attendQ);

        // 3. Get Approved Leaves
        const leaveQ = query(collection(db, "leaves"), 
            where("status", "==", "approved"),
            where("date", ">=", startStr),
            where("date", "<=", endStr)
        );
        const leaveSnap = await getDocs(leaveQ);

        // --- C. Process Data into Maps ---
        // Map: userId -> day -> Status (P, L, HD)
        const attendanceMap = {};
        
        attendSnap.forEach(doc => {
            const d = doc.data();
            const day = parseInt(d.date.split('-')[2]); // Extract Day
            if(!attendanceMap[d.salesmanId]) attendanceMap[d.salesmanId] = {};
            attendanceMap[d.salesmanId][day] = 'P'; // Present
        });

        leaveSnap.forEach(doc => {
            const d = doc.data();
            // Note: Leaves collection uses 'salesmanId' or similar. Check your DB.
            // Assuming 'salesmanId' exists in leaves collection based on previous code.
            const uid = d.salesmanId || d.userId; 
            const day = parseInt(d.date.split('-')[2]);
            if(uid) {
                if(!attendanceMap[uid]) attendanceMap[uid] = {};
                attendanceMap[uid][day] = (d.type === 'Half Day') ? 'HD' : 'L';
            }
        });

        // --- D. Render Rows ---
        tbody.innerHTML = "";
        
        usersSnap.forEach(uDoc => {
            const user = uDoc.data();
            const uid = uDoc.id;
            const userName = user.fullName || user.email;
            const record = attendanceMap[uid] || {};

            let rowHTML = `<td class="p-3 border-b border-r border-slate-200 sticky left-0 bg-white z-10 font-medium whitespace-nowrap shadow-sm text-xs">${userName}</td>`;

            for(let i = 1; i <= daysInMonth; i++) {
                const status = record[i];
                let cellContent = `<span class="block w-2 h-2 rounded-full bg-slate-200 mx-auto"></span>`; // Default: Absent/Empty
                
                if (status === 'P') {
                    cellContent = `<span class="block w-4 h-4 rounded-full bg-green-500 mx-auto shadow-sm" title="Present"></span>`;
                } else if (status === 'HD') {
                    cellContent = `<span class="block w-4 h-4 rounded-full bg-amber-500 mx-auto shadow-sm" title="Half Day"></span>`;
                } else if (status === 'L') {
                    cellContent = `<span class="block w-4 h-4 rounded-full bg-red-500 mx-auto shadow-sm" title="Leave"></span>`;
                }
                
                // Highlight Sundays column lightly
                const dateObj = new Date(year, month - 1, i);
                const isSun = (dateObj.getDay() === 0);
                const bgClass = isSun ? 'bg-slate-50' : '';

                rowHTML += `<td class="border-b border-slate-100 p-1 text-center ${bgClass}">${cellContent}</td>`;
            }

            tbody.innerHTML += `<tr>${rowHTML}</tr>`;
        });

    } catch (e) {
        console.error("Sheet Error:", e);
        if(e.message.includes("index")) alert("Index missing. See Console.");
        tbody.innerHTML = `<tr><td colspan="32" class="text-red-500 p-4">Error loading data.</td></tr>`;
    }
}

// 3. Retention Policy: Delete data older than 3 months
async function runRetentionCleanup() {
    if(!confirm("⚠️ This will PERMANENTLY delete attendance records older than 3 months.\n\nAre you sure?")) return;

    try {
        const btn = document.querySelector('button[onclick="runRetentionCleanup()"]');
        if(btn) btn.innerText = "Cleaning...";
        
        // Calculate Cutoff Date (3 months ago from 1st of current month)
        const cutoffDate = new Date();
        cutoffDate.setMonth(cutoffDate.getMonth() - 3);
        cutoffDate.setDate(1); // Set to 1st of that month
        
        // Format to YYYY-MM-DD
        const yyyy = cutoffDate.getFullYear();
        const mm = String(cutoffDate.getMonth() + 1).padStart(2, '0');
        const dd = String(cutoffDate.getDate()).padStart(2, '0');
        const cutoffStr = `${yyyy}-${mm}-${dd}`;

        console.log("Deleting records older than:", cutoffStr);

        // Query Old Data
        const q = query(collection(db, "attendance"), where("date", "<", cutoffStr));
        const snap = await getDocs(q);

        if(snap.empty) {
            alert("No old records found to clean.");
            if(btn) btn.innerText = "Clean Old Data (>3 Months)";
            return;
        }

        // Batch Delete (Firestore limit is 500 ops per batch)
        const batch = writeBatch(db);
        let count = 0;

        snap.docs.forEach((doc) => {
            batch.delete(doc.ref);
            count++;
        });

        await batch.commit();
        
        alert(`Cleanup Complete! Deleted ${count} old records.`);
        if(btn) btn.innerText = "Clean Old Data (>3 Months)";

    } catch (e) {
        console.error("Cleanup Error:", e);
        alert("Error during cleanup: " + e.message);
    }
}




// ... (Your existing attendance logic) ...

// EXPOSE FUNCTIONS TO HTML
window.loadAttendanceSheet = loadAttendanceSheet;
window.runRetentionCleanup = runRetentionCleanup;







// ==========================================
//      TRANSACTION / ACTIVITY LOGIC (FINAL & FIXED)
// ==========================================

let allFetchedTransactions = []; 
let salesmanMap = {}; 
let paginationCursorTime = null; // Tracks the timestamp of the last loaded item

// 1. Setup: Populate Salesman Dropdown & Default Dates
async function setupTransactionTab() {
    const select = document.getElementById('transSalesman');
    const startInput = document.getElementById('transStart');
    const endInput = document.getElementById('transEnd');

    if(!select) return;

    // Set Default Dates (Current Month)
    const date = new Date();
    const firstDay = new Date(date.getFullYear(), date.getMonth(), 1);
    const lastDay = new Date(date.getFullYear(), date.getMonth() + 1, 0);
    
    // Format YYYY-MM-DD using local time hack
    const formatDate = (d) => {
        const offset = d.getTimezoneOffset() * 60000;
        return new Date(d.getTime() - offset).toISOString().split('T')[0];
    };

    if(startInput) startInput.value = formatDate(firstDay);
    if(endInput) endInput.value = formatDate(lastDay);

    // Populate Salesman Dropdown & Build Map
    select.innerHTML = '<option value="all">All Staff</option>';
    try {
        const q = query(collection(db, "users"), where("role", "==", "salesman"));
        const snap = await getDocs(q);
        
        snap.forEach(doc => {
            const d = doc.data();
            const name = d.fullName || d.email;
            salesmanMap[doc.id] = name; // Cache for table display
            
            const opt = document.createElement('option');
            opt.value = doc.id;
            opt.textContent = name;
            select.appendChild(opt);
        });
    } catch (e) { console.error("Trans Setup Error:", e); }
}

// 2. Main Fetch Function (Paginated & Optimized)
async function loadTransactions(isLoadMore = false) {
    const tbody = document.getElementById('trans-table-body');
    const loadMoreBtn = document.getElementById('btnTransLoadMore');
    
    const startStr = document.getElementById('transStart').value;
    const endStr = document.getElementById('transEnd').value;
    const selectedSalesman = document.getElementById('transSalesman').value;
    const selectedType = document.getElementById('transType').value;

    if(!startStr || !endStr) return alert("Select Date Range");

    // RESET if this is a fresh filter application
    if (!isLoadMore) {
        tbody.innerHTML = '<tr><td colspan="5" class="p-6 text-center">Fetching data...</td></tr>';
        allFetchedTransactions = [];
        paginationCursorTime = null; // Reset cursor
        if(loadMoreBtn) loadMoreBtn.classList.add('hidden');
    } else {
        if(loadMoreBtn) {
            loadMoreBtn.innerText = "Loading...";
            loadMoreBtn.disabled = true;
        }
    }

    try {
        // Define Time Range
        let queryEndTs;
        if (isLoadMore && paginationCursorTime) {
            queryEndTs = paginationCursorTime; 
        } else {
            queryEndTs = Timestamp.fromDate(new Date(endStr + "T23:59:59"));
        }
        
        const startTs = Timestamp.fromDate(new Date(startStr + "T00:00:00"));

        // Helper Query Builder
        const promises = [];
        const PAGE_SIZE = 10; 

        const addQuery = (colName, dateField, isTimestamp, typeLabel, sortField) => {
            let q = query(collection(db, colName));

            // 1. Filter by Salesman
            if (selectedSalesman !== 'all') {
                q = query(q, where("salesmanId", "==", selectedSalesman));
            }

            // 2. Filter by Date Range
            if (isTimestamp) {
                q = query(q, where(dateField, "<=", queryEndTs), where(dateField, ">=", startTs));
            } else {
                q = query(q, where(dateField, ">=", startStr), where(dateField, "<=", endStr));
            }

            // 3. Sort & Limit
            q = query(q, orderBy(dateField, "desc"), limit(PAGE_SIZE));

            promises.push(
                getDocs(q).then(snap => 
                    snap.docs.map(d => ({
                        ...d.data(), 
                        _type: typeLabel, 
                        _id: d.id, 
                        _sortTime: isTimestamp ? d.data()[sortField] : Timestamp.fromDate(new Date(d.data()[dateField] + "T08:00:00")) 
                    }))
                )
            );
        };

        // --- BUILD QUERIES ---

        if (selectedType === 'all' || selectedType === 'Attendance') {
            addQuery("attendance", "date", false, "Attendance", "checkInTime");
        }
        if (selectedType === 'all' || selectedType === 'Visit') {
            addQuery("visits", "checkInTime", true, "Visit", "checkInTime");
        }
        if (selectedType === 'all' || selectedType === 'Order') {
            addQuery("orders", "orderDate", true, "Order", "orderDate");
        }
        if (selectedType === 'all' || selectedType === 'Payment') {
            addQuery("payments", "date", true, "Payment", "date");
        }
        if (selectedType === 'all' || selectedType === 'Target') {
            addQuery("daily_targets", "date", false, "Target", "date");
        }
        // NEW: OUTLETS
        if (selectedType === 'all' || selectedType === 'Outlet') {
            let q = query(collection(db, "outlets"));
            if (selectedSalesman !== 'all') q = query(q, where("createdBySalesman", "==", selectedSalesman));
            q = query(q, where("createdAt", "<=", queryEndTs), where("createdAt", ">=", startTs));
            q = query(q, orderBy("createdAt", "desc"), limit(PAGE_SIZE));
            
            promises.push(getDocs(q).then(snap => snap.docs.map(d => ({
                ...d.data(), 
                _type: 'Outlet', 
                _id: d.id, 
                _sortTime: d.data().createdAt || Timestamp.now()
            }))));
        }

        // --- PROCESS RESULTS ---
        const results = await Promise.all(promises);
        let newItems = results.flat();

        // 1. Dedup
        const existingIds = new Set(allFetchedTransactions.map(i => i._id));
        newItems = newItems.filter(i => !existingIds.has(i._id));

        // 2. Sort Unified List
        newItems.sort((a, b) => {
            const timeA = a._sortTime ? a._sortTime.seconds : 0;
            const timeB = b._sortTime ? b._sortTime.seconds : 0;
            return timeB - timeA;
        });

        // 3. Slice to Page Size
        const slicedItems = newItems.slice(0, PAGE_SIZE);

        // 4. Update Global List
        allFetchedTransactions = [...allFetchedTransactions, ...slicedItems];

        // 5. Update Cursor
        if (slicedItems.length > 0 && loadMoreBtn) {
            const lastItem = slicedItems[slicedItems.length - 1];
            if (lastItem._sortTime) {
                paginationCursorTime = new Timestamp(lastItem._sortTime.seconds, lastItem._sortTime.nanoseconds - 1);
            }
            loadMoreBtn.classList.remove('hidden');
        } else if (loadMoreBtn) {
            if(isLoadMore) alert("No more records found.");
            loadMoreBtn.classList.add('hidden');
        }

        renderTransactions(); 

    } catch (e) {
        console.error("Trans Load Error:", e);
        if(!isLoadMore) tbody.innerHTML = `<tr><td colspan="5" class="p-6 text-center text-red-500">Error: ${e.message}</td></tr>`;
        if(e.message.includes("index")) alert("Missing Index. Check Console.");
    } finally {
        if(loadMoreBtn) {
            loadMoreBtn.disabled = false;
            loadMoreBtn.innerText = "⬇ Load More Records";
        }
    }
}

// 3. Client-Side Filter (Outlet Search Only)
function filterTransactionsClientSide() {
    const outletSearch = document.getElementById('transOutletSearch').value.toLowerCase();

    const filtered = allFetchedTransactions.filter(item => {
        if(outletSearch) {
            // Check outletName (Orders/Visits) OR shopName (New Outlets)
            const name = (item.outletName || item.shopName || "").toLowerCase();
            if(!name.includes(outletSearch)) return false;
        }
        return true;
    });

    renderTransactionsList(filtered);
}

// 4. Render Functions
function renderTransactions() {
    renderTransactionsList(allFetchedTransactions);
}

function renderTransactionsList(data) {
    const tbody = document.getElementById('trans-table-body');
    tbody.innerHTML = "";

    if (data.length === 0) {
        tbody.innerHTML = '<tr><td colspan="5" class="p-6 text-center">No activity found.</td></tr>';
        return;
    }

    data.forEach(item => {
        let typeBadge = "";
        let details = "";
        let value = "";
        let rowClass = "hover:bg-slate-50 transition";

        const dateObj = item._sortTime ? item._sortTime.toDate() : new Date();
        const dateStr = dateObj.toLocaleDateString() + " " + dateObj.toLocaleTimeString([], {hour: '2-digit', minute:'2-digit'});
        
        const sId = item.salesmanId || item.createdBySalesman;
        const salesmanName = salesmanMap[sId] || "Unknown";

        switch(item._type) {
            case 'Attendance':
                typeBadge = `<span class="bg-slate-100 text-slate-600 px-2 py-1 rounded text-[10px] font-bold uppercase">Attendance</span>`;
                details = `<span class="text-slate-400 italic">Marked Present</span>`;
                value = `<span class="text-green-600 font-bold">✔</span>`;
                break;
            case 'Visit':
                typeBadge = `<span class="bg-blue-100 text-blue-600 px-2 py-1 rounded text-[10px] font-bold uppercase">Visit</span>`;
                details = `<strong>${item.outletName || 'Unknown Shop'}</strong>`;
                value = item.durationMinutes ? `${item.durationMinutes} mins` : `Active`;
                break;
            case 'Order':
                typeBadge = `<span class="bg-purple-100 text-purple-600 px-2 py-1 rounded text-[10px] font-bold uppercase">Order</span>`;
                details = `<strong>${item.outletName}</strong><br><span class="text-xs text-slate-400">${item.items ? item.items.length + ' Items' : ''}</span>`;
                const amt = item.financials ? item.financials.totalAmount : (item.totalAmount || 0);
                value = `<span class="text-purple-700 font-bold">₹${amt.toFixed(2)}</span>`;
                break;
            case 'Payment':
                const statusColor = item.status === 'approved' ? 'text-green-600' : (item.status === 'rejected' ? 'text-red-600' : 'text-orange-500');
                typeBadge = `<span class="bg-green-100 text-green-600 px-2 py-1 rounded text-[10px] font-bold uppercase">Payment</span>`;
                details = `<strong>${item.outletName}</strong><br><span class="text-xs capitalize ${statusColor}">${item.status}</span>`;
                value = `<span class="font-bold">₹${item.amount}</span>`;
                break;
            case 'Target':
                typeBadge = `<span class="bg-orange-100 text-orange-600 px-2 py-1 rounded text-[10px] font-bold uppercase">Target</span>`;
                details = `<span class="text-slate-500">Target Assigned</span>`;
                value = `🎯 ${item.targetBoxes} Boxes`;
                break;
            case 'Outlet':
                typeBadge = `<span class="bg-indigo-100 text-indigo-600 px-2 py-1 rounded text-[10px] font-bold uppercase">New Shop</span>`;
                details = `<strong>${item.shopName}</strong><br><span class="text-xs text-slate-400">${item.address || 'No Address'}</span>`;
                value = `<span class="text-xs text-slate-500">Created</span>`;
                break;
        }

        const row = `
            <tr class="${rowClass} border-b border-slate-50">
                <td class="p-4 text-xs font-medium text-slate-500">${dateStr}</td>
                <td class="p-4 font-semibold text-slate-700">${salesmanName}</td>
                <td class="p-4">${typeBadge}</td>
                <td class="p-4">${details}</td>
                <td class="p-4 text-right text-xs">${value}</td>
            </tr>
        `;
        tbody.innerHTML += row;
    });
}

// 5. EXPOSE TO HTML (Fixes the "not defined" error)
window.loadTransactions = loadTransactions;
window.filterTransactionsClientSide = filterTransactionsClientSide;








// ==========================================
//      PAYROLL / SALARY GENERATION LOGIC
// ==========================================

// 1. Open Configuration Modal
window.openSalarySettings = async function(uid, name) {
    document.getElementById('salarySettingsModal').classList.remove('hidden');
    document.getElementById('salaryModalUser').innerText = name;
    document.getElementById('salaryEditUid').value = uid;
    document.getElementById('baseSalaryInput').value = ""; // Reset

    // Fetch existing setting
    try {
        const docSnap = await getDoc(doc(db, "users", uid));
        if(docSnap.exists() && docSnap.data().baseSalaryPerDay) {
            document.getElementById('baseSalaryInput').value = docSnap.data().baseSalaryPerDay;
        }
    } catch(e) { console.error(e); }
};

// 2. Save Configuration
window.saveSalarySettings = async function() {
    const uid = document.getElementById('salaryEditUid').value;
    const amount = Number(document.getElementById('baseSalaryInput').value);
    
    if(!uid || amount < 0) return alert("Invalid Input");

    try {
        await updateDoc(doc(db, "users", uid), { baseSalaryPerDay: amount });
        alert("Settings Saved!");
        document.getElementById('salarySettingsModal').classList.add('hidden');
    } catch(e) { alert("Error: " + e.message); }
};

// 3. GENERATE REPORT (The Complex Part)
window.generateSalaryReport = async function() {
    const picker = document.getElementById('salaryMonthPicker');
    const tbody = document.getElementById('salary-table-body');
    
    if(!picker.value) return alert("Select a month first.");

    tbody.innerHTML = '<tr><td colspan="6" class="p-6 text-center">Calculating Incentives & Deductions...</td></tr>';

    const [year, month] = picker.value.split('-');
    const daysInMonth = new Date(year, month, 0).getDate();
    const startStr = `${year}-${month}-01`;
    const endStr = `${year}-${month}-${daysInMonth}`;

    // Timestamps for Order Query
    const startTs = Timestamp.fromDate(new Date(startStr + "T00:00:00"));
    const endTs = Timestamp.fromDate(new Date(endStr + "T23:59:59"));

    try {
        // A. Fetch All Salesmen
        const usersSnap = await getDocs(query(collection(db, "users"), where("role", "==", "salesman")));
        
        // B. Fetch All Required Data for the Month
        // 1. Attendance
        const attSnap = await getDocs(query(collection(db, "attendance"), where("date", ">=", startStr), where("date", "<=", endStr)));
        // 2. Leaves (Approved only)
        const leaveSnap = await getDocs(query(collection(db, "leaves"), where("status", "==", "approved"), where("date", ">=", startStr), where("date", "<=", endStr)));
        // 3. Targets
        const targetSnap = await getDocs(query(collection(db, "daily_targets"), where("date", ">=", startStr), where("date", "<=", endStr)));
        // 4. Orders (To calculate incentive achievement)
        const orderSnap = await getDocs(query(collection(db, "orders"), where("orderDate", ">=", startTs), where("orderDate", "<=", endTs)));

        // --- C. PROCESS DATA IN MEMORY ---
        const report = [];

        usersSnap.forEach(uDoc => {
            const user = uDoc.data();
            const uid = uDoc.id;
            const baseRate = user.baseSalaryPerDay || 0;

            let stats = {
                uid: uid,
                name: user.fullName || user.email,
                baseRate: baseRate,
                presentDays: 0,
                halfDays: 0,
                sickLeaves: 0,
                otherLeaves: 0, // Unpaid
                incentiveTotal: 0
            };

            // 1. Calculate Attendance
            attSnap.docs.forEach(d => { if(d.data().salesmanId === uid) stats.presentDays++; });

            // 2. Calculate Leaves & Deductions
            leaveSnap.docs.forEach(d => {
                const data = d.data();
                if(data.salesmanId === uid || data.userId === uid) {
                    if(data.type === 'Half Day') stats.halfDays++;
                    else if(data.type === 'Sick Leave') stats.sickLeaves++;
                    else stats.otherLeaves++;
                }
            });

            // 3. Calculate Incentives (Target vs Actual)
            // Group orders by Date
            const dailySales = {}; 
            orderSnap.docs.forEach(o => {
                const od = o.data();
                if(od.salesmanId === uid) {
                    const dateKey = od.orderDate.toDate().toISOString().split('T')[0]; // Local time might vary, simplest approx
                    // Better: use the date string if you saved it, else convert timestamp
                    if(!dailySales[dateKey]) dailySales[dateKey] = 0;
                    
                    if(od.items) {
                        od.items.forEach(i => dailySales[dateKey] += (Number(i.qty) || 0));
                    }
                }
            });

            // Check against targets
            targetSnap.docs.forEach(t => {
                const td = t.data();
                if(td.salesmanId === uid) {
                    const actualBoxes = dailySales[td.date] || 0;
                    if(actualBoxes > td.targetBoxes) {
                        const extra = actualBoxes - td.targetBoxes;
                        stats.incentiveTotal += (extra * (td.incentivePerBox || 0));
                    }
                }
            });

            report.push(stats);
        });

        // --- D. RENDER TABLE ---
        tbody.innerHTML = "";
        
        report.forEach((r, index) => {
            // Default Pay Calculation
            // Present = 100%, HalfDay = 50%, Sick = Optional (Default 0 here, toggle adds it), Other = 0%
            const payFromAttendance = (r.presentDays * r.baseRate);
            const payFromHalfDays = (r.halfDays * (r.baseRate / 2));
            
            // Initial Total (Without Sick Pay)
            const initialBasePay = payFromAttendance + payFromHalfDays;
            
            const rowId = `sal-row-${index}`;
            
            const row = `
                <tr class="hover:bg-slate-50 border-b border-slate-100">
                    <td class="p-4">
                        <div class="font-bold text-slate-700">${r.name}</div>
                        <div class="text-[10px] text-slate-400">Rate: ₹${r.baseRate}/day</div>
                    </td>
                    <td class="p-4 text-center">
                        <div class="text-xs">
                            <span class="text-green-600 font-bold">${r.presentDays} P</span> | 
                            <span class="text-amber-600 font-bold">${r.halfDays} HD</span> | 
                            <span class="text-red-500 font-bold">${r.otherLeaves} L</span>
                        </div>
                    </td>
                    <td class="p-4 text-center">
                        <div class="flex flex-col items-center gap-1">
                            <span class="text-xs font-bold text-slate-600">${r.sickLeaves} Days</span>
                            ${r.sickLeaves > 0 ? `
                                <label class="flex items-center gap-1 cursor-pointer">
                                    <input type="checkbox" onchange="updateRowTotal('${rowId}', ${r.baseRate}, ${r.sickLeaves})" class="w-3 h-3 rounded text-emerald-600 focus:ring-emerald-500">
                                    <span class="text-[9px] text-slate-500 uppercase font-bold">Pay?</span>
                                </label>
                            ` : '-'}
                        </div>
                    </td>
                    <td class="p-4 text-right font-medium text-slate-600">
                        ₹<span id="${rowId}-base" data-initial="${initialBasePay}">${initialBasePay.toFixed(2)}</span>
                    </td>
                    <td class="p-4 text-right font-medium text-purple-600">
                        + ₹<span id="${rowId}-inc">${r.incentiveTotal.toFixed(2)}</span>
                    </td>
                    <td class="p-4 text-right font-bold text-lg text-slate-800 bg-slate-50/50">
                        ₹<span id="${rowId}-total">${(initialBasePay + r.incentiveTotal).toFixed(2)}</span>
                    </td>
                </tr>
            `;
            tbody.innerHTML += row;
        });

        if(report.length === 0) tbody.innerHTML = '<tr><td colspan="6" class="p-6 text-center">No staff found.</td></tr>';

    } catch (e) {
        console.error(e);
        tbody.innerHTML = `<tr><td colspan="6" class="p-6 text-center text-red-500">Error: ${e.message}</td></tr>`;
    }
};

// 4. Update Logic when "Pay Sick Leave" is toggled
window.updateRowTotal = function(rowId, rate, sickDays) {
    const checkbox = event.target;
    const baseEl = document.getElementById(`${rowId}-base`);
    const incEl = document.getElementById(`${rowId}-inc`);
    const totalEl = document.getElementById(`${rowId}-total`);

    const initialBase = parseFloat(baseEl.dataset.initial);
    const incentive = parseFloat(incEl.innerText);
    
    // Calculate Sick Pay Amount
    const sickPayAmount = checkbox.checked ? (rate * sickDays) : 0;
    
    // New Totals
    const newBase = initialBase + sickPayAmount;
    const newTotal = newBase + incentive;

    // Update UI
    baseEl.innerText = newBase.toFixed(2);
    totalEl.innerText = newTotal.toFixed(2);
};

















// --- UTILITY: MANUAL REFRESH ---
// Call this from a button in HTML to reload data without refreshing the page
window.refreshDashboard = async function() {
    const btn = document.getElementById('refreshBtn');
    if(btn) {
        btn.disabled = true;
        btn.innerHTML = `<svg class="animate-spin h-4 w-4" xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24"><circle class="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" stroke-width="4"></circle><path class="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z"></path></svg>`;
    }

    try {
        console.log("Refreshing Dashboard Data...");
        await Promise.all([
            loadDashboardStats(),
            loadTodayAttendance(),
            loadPendingPayments(),
            loadPendingLeaves(),
            loadOutlets() // Refreshes outlet balances
        ]);
        
        // Refresh specific tabs if they are active
        const salesList = document.getElementById('salesmen-list');
        if(salesList && salesList.offsetParent) loadSalesmenList();
        
    } catch (error) {
        console.error("Refresh Error:", error);
    } finally {
        if(btn) {
            btn.disabled = false;
            btn.innerHTML = `<svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" stroke-width="2" stroke="currentColor" class="w-5 h-5"><path stroke-linecap="round" stroke-linejoin="round" d="M16.023 9.348h4.992v-.001M2.985 19.644v-4.992m0 0h4.992m-4.993 0l3.181 3.183a8.25 8.25 0 0013.803-3.7M4.031 9.865a8.25 8.25 0 0113.803-3.7l3.181 3.182m0-4.991v4.99" /></svg>`;
        }
    }
};







// --- DELETE OUTLET LOGIC ---
window.deleteOutlet = async function(id, name) {
    if(!confirm(`⚠️ WARNING: Are you sure you want to delete "${name}"?\n\nThis will:\n1. Delete the shop data.\n2. Remove it from all salesmen routes.\n\nThis cannot be undone.`)) {
        return;
    }

    try {
        // 1. Delete the Outlet Document
        await deleteDoc(doc(db, "outlets", id));

        // 2. CLEANUP: Remove this outlet from 'route_outlets' collection
        // We must query to find where this outlet is used
        const q = query(collection(db, "route_outlets"), where("outletId", "==", id));
        const snap = await getDocs(q);
        
        // Delete all link documents
        const deletePromises = snap.docs.map(d => deleteDoc(d.ref));
        await Promise.all(deletePromises);

        alert(`✅ "${name}" has been deleted.`);
        
        // Refresh Table
        loadOutlets();

    } catch (error) {
        console.error("Delete Error:", error);
        alert("Error deleting: " + error.message);
    }
};
























// --- NEW ROUTE MANAGEMENT ACTIONS ---

window.toggleRouteStatus = async function(routeId, newStatus) {
    try {
        await updateDoc(doc(db, "routes", routeId), { status: newStatus });
        loadRoutes();
    } catch (e) { alert("Error: " + e.message); }
};

window.changeRouteSalesman = async function(routeId, newSalesmanId) {
    try {
        await updateDoc(doc(db, "routes", routeId), { assignedSalesmanId: newSalesmanId });
        alert("Salesman reassigned for this route.");
        loadRoutes();
    } catch (e) { alert("Error: " + e.message); }
};
