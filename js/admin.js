// js/admin.js

// 1. IMPORTS

import { 
    // ... existing imports ...
    deleteDoc 
} from "https://www.gstatic.com/firebasejs/11.2.0/firebase-firestore.js";

import { onAuthStateChanged } from "https://www.gstatic.com/firebasejs/11.2.0/firebase-auth.js";
import { 
    doc, getDoc, collection, getDocs, query, where, Timestamp, 
    addDoc, updateDoc, serverTimestamp, runTransaction, orderBy, setDoc, writeBatch, limit, startAfter, increment   
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

// 1. Populate Salesman Dropdown (Fixed: Was duplicate of Outlets before)
async function populateSalesmanDropdown() {
    const select = document.getElementById('routeSalesmanSelect');
    if (!select) return;
    
    try {
        const q = query(collection(db, "users"), where("role", "==", "salesman"));
        const snap = await getDocs(q);
        
        select.innerHTML = '<option value="">Assign Salesman</option>';
        
        snap.forEach(doc => {
            const d = doc.data();
            const option = document.createElement('option');
            option.value = doc.id; // UID
            option.textContent = d.fullName || d.email;
            select.appendChild(option);
        });
    } catch (e) { console.error("Error loading salesmen:", e); }
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
                active: true,
                status: 'active'
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
    let options = `<option value="">Unassigned</option>`;
    const select = document.getElementById('routeSalesmanSelect'); 
    if(select) {
        Array.from(select.options).forEach(opt => {
            if(!opt.value) return;
            options += `<option value="${opt.value}" ${opt.value === currentId ? 'selected' : ''}>${opt.text}</option>`;
        });
    }
    return options;
}

// 4. Populate All Outlets (UPDATED: With Address & Sorting)
// ==========================================
//      UNIFIED OUTLET LOGIC (Dropdown + Global Search)
// ==========================================

// Global Cache for the Search Bar
let globalOutletCache = [];

// 1. Unified Function: Populates Route Dropdown AND Search Cache
async function populateAllOutletsDropdown() {
    const select = document.getElementById('allOutletsDropdown');
    
    try {
        const snap = await getDocs(collection(db, "outlets"));
        
        globalOutletCache = []; // Reset Cache
        
        if (select) select.innerHTML = '<option value="">Select Outlet to Add</option>';
        
        let outlets = [];
        snap.forEach(doc => {
            const data = { id: doc.id, ...doc.data() };
            outlets.push(data);
            globalOutletCache.push(data); // Add to search cache
        });

        // Sort Alphabetically
        outlets.sort((a, b) => a.shopName.localeCompare(b.shopName));

        if (select) {
            outlets.forEach(d => {
                const option = document.createElement('option');
                option.value = d.id;
                // Format: Shop Name (Phone) {Full Address}
                const addressDisplay = d.address ? `{${d.address}}` : "{No Address}";
                const phoneDisplay = d.contactPhone ? `(${d.contactPhone})` : "";
                
                option.textContent = `${d.shopName} ${phoneDisplay} ${addressDisplay}`;
                option.dataset.name = d.shopName; 
                select.appendChild(option);
            });
        }
        console.log("✅ Outlets loaded for Dropdown & Global Search");

    } catch (e) { 
        console.error("Error loading outlets:", e); 
        if (select) select.innerHTML = '<option value="">Error loading data</option>';
    }
}

// 2. Handle Search Input (Admin Header)
window.handleAdminGlobalSearch = function() {
    const input = document.getElementById('globalAdminSearch');
    const resultBox = document.getElementById('globalSearchResults');
    const term = input.value.toLowerCase().trim();

    if (term.length < 2) {
        resultBox.classList.add('hidden');
        return;
    }

    // Filter local cache (Lightning fast)
    const matches = globalOutletCache.filter(shop => 
        (shop.shopName || "").toLowerCase().includes(term) ||
        (shop.contactPhone || "").includes(term) ||
        (shop.ownerName || "").toLowerCase().includes(term) ||
        (shop.contactPerson || "").toLowerCase().includes(term)
    ).slice(0, 10); // Show top 10

    if (matches.length === 0) {
        resultBox.innerHTML = `<div class="p-4 text-xs text-slate-400 text-center">No matching shops found.</div>`;
    } else {
        resultBox.innerHTML = "";
        matches.forEach(shop => {
            const div = document.createElement('div');
            div.className = "p-3 border-b border-slate-50 hover:bg-indigo-50 cursor-pointer flex justify-between items-center transition-colors";
            div.innerHTML = `
                <div>
                    <p class="text-sm font-bold text-slate-700">${shop.shopName}</p>
                    <p class="text-[10px] text-slate-500">${shop.ownerName} • ${shop.contactPhone}</p>
                </div>
                <span class="text-[10px] bg-slate-100 text-slate-500 px-2 py-1 rounded-full">${shop.outletType || 'Shop'}</span>
            `;
            div.onclick = () => openAdminShopDetail(shop);
            resultBox.appendChild(div);
        });
    }
    resultBox.classList.remove('hidden');
};

// 3. Open Detailed Modal
window.openAdminShopDetail = async function(shop) {
    // Hide search results
    document.getElementById('globalSearchResults').classList.add('hidden');
    document.getElementById('globalAdminSearch').value = "";
    
    // Show Modal
    document.getElementById('shopDetailModal').classList.remove('hidden');

    // Populate Info
    document.getElementById('sd-name').innerText = shop.shopName;
    document.getElementById('sd-meta').innerText = `${shop.outletType} • ${shop.contactPhone}`;
    document.getElementById('sd-owner').innerText = shop.ownerName || "N/A";
    document.getElementById('sd-phone').innerText = shop.contactPhone;
    document.getElementById('sd-address').innerText = shop.address || "No Address Recorded";
    
    // Creator Info
    if (shop.createdBySalesman) {
        try {
            const userSnap = await getDoc(doc(db, "users", shop.createdBySalesman));
            document.getElementById('sd-creator').innerText = userSnap.exists() ? (userSnap.data().fullName || "Unknown") : "Unknown";
        } catch(e) { document.getElementById('sd-creator').innerText = "System"; }
    } else {
        document.getElementById('sd-creator').innerText = "Admin/Import";
    }

    const createdDate = shop.createdAt ? new Date(shop.createdAt.seconds * 1000).toLocaleDateString() : "N/A";
    document.getElementById('sd-createdDate').innerText = `Added: ${createdDate}`;

    // Map Link
    if (shop.geo && shop.geo.lat) {
        document.getElementById('sd-mapLink').href = `https://www.google.com/maps/search/?api=1&query=${shop.geo.lat},${shop.geo.lng}`;
        document.getElementById('sd-mapLink').classList.remove('hidden');
    } else {
        document.getElementById('sd-mapLink').classList.add('hidden');
    }

    // Fetch History (Orders & Payments)
    document.getElementById('sd-ordersList').innerHTML = "<li>Loading...</li>";
    document.getElementById('sd-paymentsList').innerHTML = "<li>Loading...</li>";

    try {
        const [orders, payments] = await Promise.all([
            getDocs(query(collection(db, "orders"), where("outletId", "==", shop.id), orderBy("orderDate", "desc"), limit(5))),
            getDocs(query(collection(db, "payments"), where("outletId", "==", shop.id), orderBy("date", "desc"), limit(5)))
        ]);

        // Render Orders
        const orderList = document.getElementById('sd-ordersList');
        orderList.innerHTML = "";
        if (orders.empty) orderList.innerHTML = "<li class='italic text-slate-400'>No recent orders.</li>";
        orders.forEach(d => {
            const o = d.data();
            const date = o.orderDate.toDate().toLocaleDateString();
            const amount = o.financials ? o.financials.totalAmount : 0;
            orderList.innerHTML += `
                <li class="flex justify-between border-b border-slate-50 pb-1">
                    <span>${date}</span>
                    <span class="font-bold text-indigo-600">₹${amount.toFixed(2)}</span>
                </li>`;
        });

        // Render Payments
        const payList = document.getElementById('sd-paymentsList');
        payList.innerHTML = "";
        if (payments.empty) payList.innerHTML = "<li class='italic text-slate-400'>No recent payments.</li>";
        payments.forEach(d => {
            const p = d.data();
            const date = p.date.toDate().toLocaleDateString();
            payList.innerHTML += `
                <li class="flex justify-between border-b border-slate-50 pb-1">
                    <span>${date} (${p.method})</span>
                    <span class="font-bold text-green-600">₹${p.amount}</span>
                </li>`;
        });

    } catch (e) { console.error(e); }
};

// Close dropdown on outside click
document.addEventListener('click', function(e) {
    const container = document.querySelector('.relative.group'); // Adjust selector if needed based on HTML
    const searchInput = document.getElementById('globalAdminSearch');
    const results = document.getElementById('globalSearchResults');
    
    if (searchInput && results && !searchInput.contains(e.target) && !results.contains(e.target)) {
        results.classList.add('hidden');
    }
});





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
        loadRouteOutlets(document.getElementById('selectedRouteId').value);
    } catch (e) { console.error(e); }
};

// 9. Reorder (Swap) Logic
window.changeSequence = async function(docId, direction, currentSeq) {
    const newSeq = currentSeq + direction;
    if (newSeq < 1) return; 

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















// ==========================================
//      PENDING DELIVERY LOGIC
// ==========================================

window.loadPendingDeliveries = async function() {
    const tbody = document.getElementById('deliveries-table-body');
    const totalEl = document.getElementById('delivery-total-count');
    const upcomingEl = document.getElementById('delivery-upcoming-count');

    if (!tbody) return;

    tbody.innerHTML = '<tr><td colspan="6" class="p-6 text-center italic">Loading pending orders...</td></tr>';

    try {
        // Fetch orders sorted by Due Date
        const q = query(
            collection(db, "orders"), 
            orderBy("deliveryDueDate", "asc"),
            limit(100)
        );
        
        const snap = await getDocs(q);

        tbody.innerHTML = "";
        
        if (snap.empty) {
            tbody.innerHTML = '<tr><td colspan="6" class="p-6 text-center text-slate-400">No pending deliveries found.</td></tr>';
            totalEl.innerText = "0";
            upcomingEl.innerText = "0";
            return;
        }

        let totalPending = 0;
        let upcomingCount = 0;
        
        // Date Logic
        const now = new Date();
        now.setHours(0,0,0,0); // Normalize today to midnight
        
        const nextWeek = new Date();
        nextWeek.setDate(now.getDate() + 7);
        nextWeek.setHours(23,59,59,999); // End of 7th day

        snap.forEach(docSnap => {
            const data = docSnap.data();
            const orderId = docSnap.id;
            
            // 1. Calculate Due Date & Status
            let dueDateObj = data.deliveryDueDate ? data.deliveryDueDate.toDate() : null;
            let dueStr = "N/A";
            let dateClass = "text-slate-600";
            
            if (dueDateObj) {
                // Normalize due date for accurate comparison
                const checkDate = new Date(dueDateObj);
                checkDate.setHours(0,0,0,0);

                dueStr = dueDateObj.toLocaleDateString('en-IN', { day: 'numeric', month: 'short', year: 'numeric' });
                
                // Urgency Color Logic
                const diffTime = checkDate - now;
                const daysDiff = Math.ceil(diffTime / (1000 * 60 * 60 * 24)); 
                
                if (daysDiff < 0) {
                    dateClass = "text-red-600 font-bold"; // Overdue
                    dueStr += " (Overdue)";
                } else if (daysDiff <= 2) {
                    dateClass = "text-orange-500 font-bold"; // Urgent
                } else {
                    dateClass = "text-green-600 font-bold"; // Safe
                }

                // 2. Count for 7-Day Card
                // Logic: If date is today or future AND within next 7 days
                if (checkDate >= now && checkDate <= nextWeek) {
                    upcomingCount++;
                }
            }

            totalPending++;

            // 3. Calculate Total Qty
            let totalQty = 0;
            if (data.items && Array.isArray(data.items)) {
                totalQty = data.items.reduce((sum, item) => sum + (Number(item.qty) || 0), 0);
            }

            // 4. Financials & Items String
            const totalAmt = data.financials ? data.financials.totalAmount : 0;
            const itemCount = data.items ? data.items.length : 0;
            const itemNames = data.items ? data.items.map(i => i.name).slice(0, 1).join(", ") + (itemCount > 1 ? "..." : "") : "";

            // 5. Render Row
           const row = `
    <tr class="hover:bg-slate-50 transition border-b border-slate-50 group">
        <td class="p-4">
            <div class="${dateClass} text-sm">${dueStr}</div>
            <div class="text-[10px] text-slate-400">Ord: ${data.orderDate.toDate().toLocaleDateString()}</div>
        </td>
        <td class="p-4">
            <span class="bg-slate-100 text-slate-600 px-2 py-1 rounded text-[10px] font-bold uppercase whitespace-nowrap">
                ${data.routeName || 'N/A'}
            </span>
        </td>
        <td class="p-4">
            <div class="font-bold text-slate-700 text-sm">${data.outletName}</div>
            <div class="text-xs text-slate-500">By: ${data.salesmanName}</div>
        </td>
        <td class="p-4 text-center">
            <span class="bg-indigo-50 text-indigo-700 font-bold px-2 py-1 rounded-lg text-sm">${totalQty}</span>
        </td>
        <td class="p-4">
            <div class="font-bold text-slate-800">₹${totalAmt.toFixed(2)}</div>
            <div class="text-xs text-slate-500 truncate max-w-[120px]">
                ${itemCount} Types
            </div>
        </td>
        <td class="p-4 text-right flex items-center justify-end gap-2">
            <!-- NEW INVOICE BUTTON -->
            <button onclick="generateInvoice('${orderId}')" 
                    class="text-blue-600 bg-blue-50 hover:bg-blue-100 p-2 rounded-lg transition-colors flex items-center gap-1"
                    title="Download Invoice PDF">
                 <svg xmlns="http://www.w3.org/2000/svg" class="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M7 21h10a2 2 0 002-2V9.414a1 1 0 00-.293-.707l-5.414-5.414A1 1 0 0012.586 3H7a2 2 0 00-2 2v14a2 2 0 002 2z" /></svg>
                 <span class="text-xs font-bold">Inv</span>
            </button>

            <!-- EXISTING DELETE BUTTON -->
            <button onclick="deleteOrder('${orderId}', ${totalAmt}, '${data.outletId}', '${data.outletName}')" 
                    class="text-slate-400 hover:text-red-600 p-2 rounded-lg hover:bg-red-50 transition-colors" 
                    title="Delete Order">
                 <svg xmlns="http://www.w3.org/2000/svg" class="h-5 w-5" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16" /></svg>
            </button>
        </td>
    </tr>
`;
            tbody.innerHTML += row;
        });

        // Update Stats Cards
        totalEl.innerText = totalPending;
        upcomingEl.innerText = upcomingCount;

    } catch (error) {
        console.error("Deliveries Error:", error);
        tbody.innerHTML = `<tr><td colspan="6" class="p-6 text-center text-red-400">Error loading data.</td></tr>`;
    }
};






// --- DELETE ORDER FUNCTION ---
window.deleteOrder = async function(orderId, amount, outletId, outletName) {
    if(!confirm(`⚠️ PERMANENT DELETE WARNING\n\nAre you sure you want to delete the order for "${outletName}"?\n\nAmount: ₹${amount}\n\nThis will:\n1. Remove the order permanently.\n2. DEDUCT ₹${amount} from the shop's outstanding balance.`)) {
        return;
    }

    try {
        // 1. Reference the Order and the Outlet
        const orderRef = doc(db, "orders", orderId);
        const outletRef = doc(db, "outlets", outletId);

        // 2. Perform updates (Delete Order + Reverse Balance)
        // We use 'increment(-amount)' to subtract the order value from the debt
        const batch = writeBatch(db);
        
        batch.delete(orderRef);
        batch.update(outletRef, { 
            currentBalance: increment(-amount) // Reverses the charge
        });

        await batch.commit();

        alert("✅ Order deleted and shop balance adjusted.");
        
        // 3. Refresh the table and stats
        loadPendingDeliveries();
        loadDashboardStats(); // To update the total credit card on dashboard
        
    } catch (error) {
        console.error("Delete Order Error:", error);
        alert("Failed to delete: " + error.message);
    }
};














// ==========================================
//      EXPORT TO EXCEL (CSV) LOGIC
// ==========================================

// 1. Open Modal and Set Default Dates
window.openExportModal = function() {
    document.getElementById('exportModal').classList.remove('hidden');
    
    // Set Default: First day of month to Today
    const date = new Date();
    const firstDay = new Date(date.getFullYear(), date.getMonth(), 1);
    
    // Format YYYY-MM-DD
    const formatDate = (d) => {
        const offset = d.getTimezoneOffset() * 60000;
        return new Date(d.getTime() - offset).toISOString().split('T')[0];
    };

    document.getElementById('exportEndDate').value = formatDate(date);
    document.getElementById('exportStartDate').value = formatDate(firstDay);
};

// 2. Generate and Download Logic
window.generateDeliveryExcel = async function() {
    const startStr = document.getElementById('exportStartDate').value;
    const endStr = document.getElementById('exportEndDate').value;
    const btn = document.getElementById('btnGenerateExcel');

    if(!startStr || !endStr) return alert("Please select a valid date range.");

    try {
        btn.disabled = true;
        btn.innerHTML = `<svg class="animate-spin h-5 w-5 mr-2" viewBox="0 0 24 24"><circle class="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" stroke-width="4"></circle><path class="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z"></path></svg> Generating...`;

        // 1. Fetch Orders in Date Range (Pending Only or All?)
        // Assuming "Pending Deliveries" context, we might filter by status != 'delivered'
        // OR simply export all orders taken in that period.
        // Let's filter for active orders (pending) as per "Pending Deliveries" requirement.
        
        const startTs = Timestamp.fromDate(new Date(startStr + "T00:00:00"));
        const endTs = Timestamp.fromDate(new Date(endStr + "T23:59:59"));

        const q = query(
            collection(db, "orders"),
            where("orderDate", ">=", startTs),
            where("orderDate", "<=", endTs),
            where("status", "==", "pending") // Only Pending Deliveries
        );

        const snap = await getDocs(q);

        if(snap.empty) {
            alert("No pending deliveries found in this date range.");
            btn.disabled = false;
            btn.innerText = "Download .CSV File";
            return;
        }

        // 2. Prepare Data & Fetch Missing Outlet Info (Address, Contact)
        let csvContent = "data:text/csv;charset=utf-8,";
        // BOM for Excel to read UTF-8 correctly
        csvContent += "\ufeff"; 
        
        // Headers
        csvContent += "Order Date,Outlet Name,Auth Person,Contact Number,Full Address,Product Details,Total Qty,Total Amount,Route,Salesman\n";

        // We need to fetch Outlet details for Address/Contact Person
        // Using Promise.all to fetch them in parallel for speed
        const orders = [];
        const outletIds = new Set();
        
        snap.forEach(doc => {
            const d = doc.data();
            orders.push(d);
            if(d.outletId) outletIds.add(d.outletId);
        });

        // Fetch all unique outlets involved
        const outletMap = {};
        const outletPromises = Array.from(outletIds).map(id => getDoc(doc(db, "outlets", id)));
        const outletSnaps = await Promise.all(outletPromises);
        
        outletSnaps.forEach(oSnap => {
            if(oSnap.exists()) {
                outletMap[oSnap.id] = oSnap.data();
            }
        });

        // 3. Build Rows
        orders.forEach(order => {
            const outlet = outletMap[order.outletId] || {};
            
            // A. Format Date
            const dateObj = order.orderDate.toDate();
            const dateStr = dateObj.toLocaleDateString('en-GB'); // DD/MM/YYYY

            // B. Outlet Info
            const outletName = escapeCsv(order.outletName);
            const authPerson = escapeCsv(outlet.contactPerson || outlet.ownerName || "N/A");
            const authNumber = escapeCsv(outlet.contactPhone || "N/A");
            const fullAddress = escapeCsv(outlet.address || "Address Not Recorded");

            // C. Product Details & Qty
            let productDetails = "";
            let totalQty = 0;
            
            if(order.items && Array.isArray(order.items)) {
                // Format: "Maggi (10) | Coke (5)"
                productDetails = order.items.map(i => `${i.name} (${i.qty})`).join(" | ");
                totalQty = order.items.reduce((sum, i) => sum + (Number(i.qty) || 0), 0);
            }
            productDetails = escapeCsv(productDetails);

            // D. Other Info
            const amount = (order.financials?.totalAmount || 0).toFixed(2);
            const route = escapeCsv(order.routeName || "N/A");
            const salesman = escapeCsv(order.salesmanName);

            // Append Line
            csvContent += `${dateStr},${outletName},${authPerson},${authNumber},${fullAddress},${productDetails},${totalQty},${amount},${route},${salesman}\n`;
        });

        // 4. Trigger Download
        const encodedUri = encodeURI(csvContent);
        const link = document.createElement("a");
        link.setAttribute("href", encodedUri);
        link.setAttribute("download", `Pending_Deliveries_${startStr}_to_${endStr}.csv`);
        document.body.appendChild(link);
        link.click();
        document.body.removeChild(link);

        document.getElementById('exportModal').classList.add('hidden');

    } catch (error) {
        console.error("Export Error:", error);
        alert("Failed to export: " + error.message);
    } finally {
        btn.disabled = false;
        btn.innerText = "Download .CSV File";
    }
};

// Helper to handle commas and quotes in CSV
function escapeCsv(str) {
    if (str == null) return "";
    str = String(str).replace(/"/g, '""'); // Escape double quotes
    if (str.search(/("|,|\n)/g) >= 0) {
        str = `"${str}"`; // Wrap in quotes if it contains comma, quote or newline
    }
    return str;
}











// ==========================================
//      HELPER: SESSION YEAR CALCULATOR
// ==========================================
function getFiscalSession() {
    const today = new Date();
    const curMonth = today.getMonth(); // 0 = Jan
    const curYear = today.getFullYear();
    
    if (curMonth < 3) {
        return `${curYear - 1}-${curYear}`;
    } else {
        return `${curYear}-${curYear + 1}`;
    }
}

// ==========================================
//      HELPER: USER INPUT MODAL (Enhanced with Add Scheme)
// ==========================================
function askInvoiceDetails(defaults, orderItems) {
    return new Promise((resolve, reject) => {
        try {
            const existing = document.getElementById('inv-settings-modal');
            if (existing) existing.remove();

            // 1. Build Initial Rows
            let itemsHtml = '';
            const safeItems = Array.isArray(orderItems) ? orderItems : [];

            if (safeItems.length === 0) {
                itemsHtml = '<tr id="no-items-row"><td colspan="4" style="padding:10px; text-align:center; color:red;">No items in order</td></tr>';
            } else {
                safeItems.forEach((item, index) => {
                    const itemName = item.name || "Unknown Item";
                    const isScheme = itemName.toLowerCase().includes("scheme");
                    let defRate = isScheme ? 106.00 : (Number(item.price) || 0);
                    let qty = Number(item.qty) || 0;

                    itemsHtml += createRowHtml(itemName, qty, defRate, isScheme, false);
                });
            }

            // 2. Helper to create Row HTML
            function createRowHtml(name, qty, rate, isScheme, isNew) {
                const schemeLabel = isScheme ? '<span style="color:red; font-size:9px; font-weight:bold;">(SCHEME)</span>' : '';
                return `
                    <tr class="item-row ${isScheme ? 'scheme-row' : ''}" ${isNew ? 'style="background:#f0fdf4;"' : ''}>
                        <td style="padding:8px; border-bottom:1px solid #eee; font-size:11px; color:#333;">
                            <input type="text" class="inp-name" value="${name}" readonly style="border:none; background:transparent; width:100%; font-size:11px;">
                            ${schemeLabel}
                        </td>
                        <td style="padding:8px; border-bottom:1px solid #eee; text-align:center;">
                            <input type="number" class="inp-qty" value="${qty}" style="width:50px; padding:4px; border:1px solid #ccc; text-align:center;">
                        </td>
                        <td style="padding:8px; border-bottom:1px solid #eee; text-align:right;">
                            <input type="number" step="0.01" class="inp-rate" value="${rate.toFixed(2)}" style="width:70px; padding:4px; border:1px solid #ccc; text-align:right; font-weight:bold;">
                        </td>
                        <td style="padding:8px; border-bottom:1px solid #eee; text-align:center;">
                            ${isNew ? '<button class="btn-del-row" style="color:red; border:none; background:none; cursor:pointer;">&times;</button>' : ''}
                        </td>
                    </tr>
                `;
            }

            // 3. Modal HTML
            const modal = document.createElement('div');
            modal.id = 'inv-settings-modal';
            modal.style.cssText = `
                position: fixed; top: 0; left: 0; width: 100%; height: 100%;
                background: rgba(0,0,0,0.6); z-index: 1000000;
                display: flex; justify-content: center; align-items: center;
                font-family: sans-serif;
            `;

            modal.innerHTML = `
                <div style="background:white; width:650px; max-height:95vh; border-radius:12px; box-shadow:0 25px 50px -12px rgba(0,0,0,0.25); display:flex; flex-direction:column; overflow:hidden;">
                    
                    <div style="padding:15px 20px; border-bottom:1px solid #e2e8f0; background:#f8fafc; display:flex; justify-content:space-between; align-items:center;">
                        <div>
                            <h3 style="margin:0; color:#0f172a; font-weight:800; font-size:16px;">Invoice Configuration</h3>
                        </div>
                        <button id="btn-inv-close-x" style="border:none; background:none; font-size:20px; cursor:pointer;">&times;</button>
                    </div>

                    <div style="padding:20px; overflow-y:auto;">
                        <div style="display:grid; grid-template-columns: 1.5fr 1fr 1fr; gap:10px; margin-bottom:15px;">
                            <div><label style="font-size:10px; font-weight:700;">INVOICE NO</label><input type="text" id="inp-inv-no" value="${defaults.invNo}" style="width:100%; padding:8px; border:1px solid #cbd5e1; border-radius:4px; font-weight:bold;"></div>
                            <div><label style="font-size:10px; font-weight:700;">DATE</label><input type="date" id="inp-inv-date" value="${defaults.date}" style="width:100%; padding:8px; border:1px solid #cbd5e1; border-radius:4px;"></div>
                            <div><label style="font-size:10px; font-weight:700;">VEHICLE NO</label><input type="text" id="inp-vehicle" placeholder="XX-00-XX-0000" style="width:100%; padding:8px; border:1px solid #cbd5e1; border-radius:4px;"></div>
                        </div>

                        <div style="margin-bottom:15px;">
                            <label style="font-size:10px; font-weight:700;">ADDRESS</label>
                            <textarea id="inp-address" rows="2" style="width:100%; padding:8px; border:1px solid #cbd5e1; border-radius:4px; resize:none;">${defaults.address}</textarea>
                        </div>

                        <div style="border:1px solid #e2e8f0; border-radius:6px; overflow:hidden; margin-bottom:10px;">
                            <table style="width:100%; border-collapse:collapse;" id="inv-items-table">
                                <thead style="background:#f1f5f9;">
                                    <tr>
                                        <th style="padding:8px; text-align:left; font-size:10px;">ITEM DESCRIPTION</th>
                                        <th style="padding:8px; text-align:center; font-size:10px;">QTY</th>
                                        <th style="padding:8px; text-align:right; font-size:10px;">RATE (₹)</th>
                                        <th style="width:30px;"></th>
                                    </tr>
                                </thead>
                                <tbody>${itemsHtml}</tbody>
                            </table>
                        </div>

                        <!-- Buttons Row -->
                        <div style="display:flex; justify-content:space-between; align-items:center; margin-bottom:15px;">
                            <button id="btn-add-scheme" style="padding:6px 12px; background:#dcfce7; color:#166534; border:1px solid #bbf7d0; border-radius:4px; font-size:11px; font-weight:bold; cursor:pointer;">
                                + Add "Scheme 11+1" Offer
                            </button>
                            
                            <div style="display:flex; align-items:center; gap:10px; background:#fff1f2; padding:8px; border-radius:6px; border:1px dashed #fda4af;">
                                <label style="font-size:11px; font-weight:bold; color:#be123c;">LESS DISCOUNT (₹):</label>
                                <input type="number" id="inp-discount" value="0.00" style="width:90px; padding:6px; border:1px solid #f43f5e; border-radius:4px; text-align:right; font-weight:bold; color:#be123c;">
                            </div>
                        </div>
                    </div>

                    <div style="padding:15px 20px; border-top:1px solid #e2e8f0; background:#f8fafc; display:flex; justify-content:flex-end; gap:10px;">
                        <button id="btn-inv-cancel" style="padding:10px 20px; border:1px solid #cbd5e1; background:white; border-radius:6px; font-weight:bold;">Cancel</button>
                        <button id="btn-inv-generate" style="padding:10px 25px; border:none; background:#0f172a; color:white; border-radius:6px; font-weight:bold;">Generate PDF</button>
                    </div>
                </div>
            `;

            document.body.appendChild(modal);

            // --- 4. LOGIC: Auto-Calculate Discount ---
            const discountInput = document.getElementById('inp-discount');
            const tbody = document.querySelector('#inv-items-table tbody');

            const calculateDiscount = () => {
                let totalSchemeAmt = 0;
                const rows = document.querySelectorAll('.item-row');
                
                rows.forEach(row => {
                    const name = row.querySelector('.inp-name').value.toLowerCase();
                    if (name.includes('scheme')) {
                        const q = parseFloat(row.querySelector('.inp-qty').value) || 0;
                        const r = parseFloat(row.querySelector('.inp-rate').value) || 0;
                        totalSchemeAmt += (q * r);
                    }
                });
                discountInput.value = totalSchemeAmt.toFixed(2);
            };

            // Run initial calc
            calculateDiscount();

            // Event Delegation for inputs (Rate/Qty changes)
            tbody.addEventListener('input', (e) => {
                if (e.target.classList.contains('inp-qty') || e.target.classList.contains('inp-rate')) {
                    calculateDiscount();
                }
            });

            // Event for Delete Button
            tbody.addEventListener('click', (e) => {
                if (e.target.classList.contains('btn-del-row')) {
                    e.target.closest('tr').remove();
                    calculateDiscount();
                }
            });

            // --- 5. LOGIC: Add Scheme Button ---
            document.getElementById('btn-add-scheme').onclick = () => {
                const noItemsRow = document.getElementById('no-items-row');
                if(noItemsRow) noItemsRow.remove();

                const newHtml = createRowHtml("Scheme 11+1 Offer", 1, 106.00, true, true);
                tbody.insertAdjacentHTML('beforeend', newHtml);
                calculateDiscount(); // Update discount immediately
            };

            // --- 6. Final Submission ---
            const close = () => { modal.remove(); reject(new Error("Cancelled")); };
            document.getElementById('btn-inv-close-x').onclick = close;
            document.getElementById('btn-inv-cancel').onclick = close;

            document.getElementById('btn-inv-generate').onclick = () => {
                const updatedItems = [];
                const rows = document.querySelectorAll('.item-row');
                
                rows.forEach(row => {
                    updatedItems.push({
                        name: row.querySelector('.inp-name').value,
                        qty: Number(row.querySelector('.inp-qty').value),
                        rate: Number(row.querySelector('.inp-rate').value),
                        amount: Number(row.querySelector('.inp-qty').value) * Number(row.querySelector('.inp-rate').value)
                    });
                });

                const data = {
                    invNo: document.getElementById('inp-inv-no').value,
                    date: document.getElementById('inp-inv-date').value,
                    vehicle: document.getElementById('inp-vehicle').value || "N/A",
                    address: document.getElementById('inp-address').value,
                    discount: Number(discountInput.value) || 0,
                    items: updatedItems
                };
                
                modal.remove();
                resolve(data);
            };

        } catch (e) {
            reject(e);
        }
    });
}

// ==========================================
//      MAIN GENERATION FUNCTION
// ==========================================

window.generateInvoice = async function(orderId) {
    const btn = event.currentTarget;
    const originalText = btn.innerHTML;
    let overlay = null;

    try {
        btn.disabled = true;
        btn.innerHTML = `Loading...`;

        // 1. Data Fetch
        const orderSnap = await getDoc(doc(db, "orders", orderId));
        if (!orderSnap.exists()) throw new Error("Order not found");
        const order = orderSnap.data();

        const outletSnap = await getDoc(doc(db, "outlets", order.outletId));
        const outlet = outletSnap.exists() ? outletSnap.data() : {};

        // 2. Defaults
        const session = getFiscalSession();
        const shortId = orderId.slice(-4).toUpperCase();
        const defaultInvNo = `FP/${session}/${shortId}`;
        const today = new Date().toISOString().split('T')[0];
        const defaultAddress = outlet.address ? outlet.address.replace(/(\r\n|\n|\r)/gm, ", ") : "Address Not Provided";

        // 3. Open Modal
        let userSettings;
        try {
            userSettings = await askInvoiceDetails({
                invNo: defaultInvNo,
                date: today,
                address: defaultAddress
            }, order.items || []);
        } catch (e) {
            btn.disabled = false;
            btn.innerHTML = originalText;
            return;
        }

        btn.innerHTML = `Generating...`;

        // 4. Calculations
        const subTotal = userSettings.items.reduce((sum, item) => sum + item.amount, 0);
        const discountAmount = userSettings.discount;
        const taxableValue = subTotal - discountAmount;

        const taxRate = 0.05; 
        const taxAmount = taxableValue * taxRate;
        const cgst = taxAmount / 2;
        const sgst = taxAmount / 2;
        const grandTotal = taxableValue + taxAmount;

        // 5. Display Variables
        const route = order.routeName || "N/A";
        const custName = order.outletName || "Unknown";
        const custPhone = outlet.contactPhone || "N/A";
        const custGst = outlet.gstNumber || "N/A";
        const dateParts = userSettings.date.split('-');
        const displayDate = `${dateParts[2]}-${dateParts[1]}-${dateParts[0]}`;

        // 6. SVG Logo
        const svgLogo = `<svg xmlns="http://www.w3.org/2000/svg" width="120" height="40" viewBox="0 0 847 334">
<g>
<path d="M 88.40 244.90 C86.59,242.89 86.48,240.03 86.00,184.15 C85.72,151.89 85.14,124.94 84.69,124.25 C84.25,123.56 82.83,123.00 81.55,123.00 C80.27,123.00 78.16,122.14 76.86,121.08 C74.59,119.24 74.51,118.69 74.65,106.55 C74.75,98.85 75.25,93.41 75.94,92.57 C76.56,91.82 78.59,90.93 80.44,90.58 C82.29,90.23 84.24,89.40 84.77,88.72 C85.31,88.05 85.97,83.45 86.24,78.50 C87.34,58.59 98.25,40.28 115.00,30.25 C116.93,29.09 122.10,26.89 126.50,25.34 L 134.50 22.53 L 173.29 22.40 C210.23,22.28 212.20,22.37 214.54,24.21 C216.94,26.10 217.00,26.48 217.00,39.92 C217.00,52.64 216.84,53.83 214.90,55.60 C212.93,57.38 210.38,57.53 175.65,58.00 C135.06,58.55 135.50,58.48 128.75,64.80 C125.19,68.14 122.00,76.75 122.00,83.06 C122.00,87.55 122.27,88.15 124.68,89.07 C126.29,89.68 135.65,89.97 148.02,89.79 C164.39,89.56 169.02,89.78 170.34,90.87 C171.73,92.03 172.00,94.34 171.98,105.37 C171.98,112.59 171.63,119.03 171.21,119.69 C169.52,122.34 164.27,123.00 144.63,123.00 C130.23,123.00 124.05,123.35 123.20,124.20 C122.29,125.11 122.00,139.70 122.00,183.75 L 122.00 242.09 L 119.55 244.55 C117.18,246.91 116.58,247.00 103.70,247.00 C91.36,247.00 90.16,246.84 88.40,244.90 ZM 473.32 198.34 C472.66,198.20 472.08,198.12 471.59,197.88 C468.49,196.35 468.56,188.40 468.25,118.09 L 467.91 41.39 L 470.03 38.69 C472.14,36.01 472.19,36.00 485.51,36.00 C495.11,36.00 499.11,36.35 499.69,37.25 C500.14,37.94 500.73,56.69 501.00,78.92 C501.32,104.58 501.87,119.44 502.50,119.62 C503.05,119.77 508.90,112.88 515.50,104.29 C522.10,95.71 528.93,87.07 530.68,85.09 L 533.87 81.50 L 547.18 80.93 C554.51,80.61 561.74,80.77 563.26,81.28 C566.44,82.34 567.77,86.01 566.22,89.42 C565.65,90.66 557.44,101.32 547.96,113.09 C529.63,135.88 528.09,138.17 529.72,140.22 C530.27,140.92 535.60,147.80 541.56,155.50 C547.52,163.20 555.91,173.91 560.20,179.30 C566.51,187.23 568.00,189.76 568.00,192.53 C568.00,197.82 564.74,199.00 550.10,199.00 C543.09,199.00 537.03,198.51 535.54,197.83 C534.13,197.19 526.64,188.87 518.89,179.33 C511.15,169.80 504.42,162.00 503.94,162.00 C501.78,162.00 501.00,166.85 501.00,180.28 C501.00,190.11 501.07,194.62 498.86,196.72 C496.92,198.57 493.21,198.55 486.15,198.66 C480.29,198.74 474.52,198.60 473.32,198.34 ZM 308.00 200.89 C293.78,199.41 282.25,194.09 272.62,184.56 C256.69,168.80 250.68,140.55 258.40,117.67 C265.88,95.50 284.47,80.98 307.50,79.33 C330.56,77.67 350.09,87.37 358.19,104.50 C366.59,122.26 359.22,141.39 340.63,150.09 C333.86,153.25 320.30,156.53 310.00,157.47 C295.42,158.82 293.00,159.18 293.00,160.04 C293.00,160.53 294.38,162.50 296.06,164.42 C300.18,169.11 308.11,172.00 316.88,172.00 C325.33,172.00 331.56,170.17 339.19,165.46 C343.43,162.85 345.79,161.98 347.50,162.41 C348.81,162.74 352.38,165.96 355.44,169.56 C362.79,178.23 362.80,180.16 355.50,186.83 C343.95,197.38 325.83,202.74 308.00,200.89 ZM 602.76 199.44 C592.14,196.87 578.61,188.29 572.47,180.26 C567.80,174.14 562.41,163.00 560.52,155.54 C558.58,147.92 558.58,131.41 560.52,123.19 C565.02,104.07 578.05,89.14 596.50,81.96 C601.61,79.97 604.35,79.62 615.00,79.58 C628.90,79.53 634.34,80.76 643.53,86.02 C651.51,90.58 657.68,97.10 661.26,104.74 C663.94,110.47 664.39,112.57 664.40,119.46 C664.42,125.55 663.91,128.64 662.30,132.18 C659.65,138.01 652.98,145.34 647.27,148.69 C638.51,153.82 619.72,157.99 605.31,158.00 C600.80,158.00 596.86,158.42 596.54,158.94 C595.64,160.40 601.85,166.88 606.41,169.24 C609.34,170.76 612.95,171.48 619.14,171.80 C629.18,172.31 635.39,170.68 643.77,165.35 C646.67,163.51 649.80,162.00 650.73,162.00 C652.69,162.00 662.39,171.91 664.59,176.17 C666.62,180.09 665.01,183.27 658.50,188.23 C647.24,196.81 634.00,201.00 618.50,200.90 C613.00,200.86 605.92,200.21 602.76,199.44 ZM 676.00 254.34 C671.44,252.51 671.00,251.16 671.00,238.88 C671.00,231.85 670.83,228.67 672.32,226.82 C673.72,225.08 676.59,224.51 682.46,223.01 C691.17,220.78 694.67,219.10 699.55,214.82 C703.20,211.62 709.00,201.48 709.00,198.32 C709.00,197.36 705.68,188.69 701.62,179.04 C697.57,169.39 691.22,154.07 687.52,145.00 C683.81,135.93 677.16,119.75 672.73,109.06 C664.75,89.83 663.52,85.08 665.88,82.72 C666.69,81.90 672.00,81.39 681.92,81.18 C696.66,80.86 696.76,80.87 698.69,83.33 C699.75,84.68 704.83,97.83 709.96,112.55 C721.74,146.30 724.53,153.56 725.62,153.25 C726.11,153.11 726.52,152.66 726.54,152.25 C726.59,151.43 728.70,144.66 729.90,141.50 C730.99,138.61 736.00,123.15 742.47,102.70 C745.65,92.65 748.96,84.04 750.05,82.95 C751.79,81.21 753.46,81.00 765.31,81.00 C784.75,81.00 784.87,81.19 777.74,101.50 C771.43,119.48 756.45,161.16 746.83,187.50 C732.07,227.91 725.64,237.35 706.35,246.90 C694.97,252.53 680.41,256.10 676.00,254.34 ZM 396.00 199.57 C387.60,197.81 376.60,193.37 372.91,190.27 C370.90,188.58 370.00,186.90 370.00,184.85 C370.00,180.48 376.30,167.50 379.42,165.46 C381.98,163.78 382.25,163.82 388.78,166.80 C409.92,176.45 429.54,174.27 426.61,162.59 C425.71,158.98 422.44,157.17 411.78,154.38 C385.83,147.58 376.97,141.45 372.45,127.16 C369.97,119.32 370.80,107.14 374.27,100.50 C381.70,86.30 394.73,79.78 415.64,79.80 C431.17,79.83 448.58,85.37 452.66,91.60 C454.25,94.04 454.25,94.49 452.56,99.46 C451.57,102.36 449.47,106.81 447.88,109.36 C445.47,113.23 444.49,114.00 441.95,114.00 C440.27,114.00 437.65,113.35 436.13,112.57 C431.79,110.32 417.26,107.72 411.93,108.23 C403.40,109.05 399.95,113.29 403.06,119.11 C404.36,121.55 406.57,122.44 420.32,126.09 C446.50,133.05 458.00,143.98 458.00,161.93 C458.00,178.28 448.20,191.95 432.09,198.11 C424.93,200.85 405.75,201.62 396.00,199.57 ZM 188.00 198.31 C184.02,196.88 184.00,196.55 184.00,139.43 C184.00,89.32 184.15,84.12 185.65,82.87 C186.79,81.93 191.04,81.39 199.21,81.14 C213.12,80.73 215.00,81.56 215.00,88.15 C215.00,90.27 215.40,92.00 215.89,92.00 C216.38,92.00 218.95,90.21 221.60,88.02 C228.27,82.51 236.24,80.00 247.08,80.00 C261.22,80.00 262.80,82.81 257.03,97.76 C252.43,109.70 251.50,110.60 242.78,111.44 C234.09,112.29 228.63,114.55 224.29,119.13 C218.08,125.68 217.68,128.12 217.06,163.34 L 216.50 195.18 L 214.14 197.09 C212.12,198.73 210.19,198.99 200.64,198.92 C194.51,198.88 188.82,198.60 188.00,198.31 ZM 571.27 321.54 C566.71,319.53 564.01,314.63 564.00,308.38 C564.00,297.85 572.46,286.07 590.45,271.56 C595.15,267.77 595.44,265.18 590.80,268.43 C587.87,270.48 583.53,270.43 579.93,268.30 C577.17,266.67 576.97,266.68 574.78,268.73 C569.98,273.22 563.75,274.16 559.72,271.00 C555.06,267.33 555.19,259.64 560.23,242.50 C563.32,231.97 564.54,230.00 567.96,230.00 C571.69,230.00 572.56,232.53 570.57,237.64 C568.72,242.43 565.00,257.17 565.00,259.73 C565.00,260.77 565.63,262.48 566.40,263.53 C567.63,265.22 568.09,265.29 570.27,264.12 C573.96,262.15 576.47,256.82 579.93,243.65 C581.64,237.13 583.50,230.94 584.05,229.90 C585.31,227.56 590.79,227.29 591.65,229.52 C591.97,230.35 590.88,235.87 589.22,241.77 C584.99,256.87 584.82,257.80 586.01,260.02 C587.57,262.93 589.35,262.46 593.26,258.14 C596.66,254.37 598.11,250.80 602.94,234.26 C604.70,228.23 605.46,226.92 607.52,226.40 C608.88,226.06 610.72,226.06 611.61,226.40 C613.56,227.15 613.39,228.35 609.14,244.24 C604.62,261.12 604.89,262.58 611.40,256.82 C614.51,254.07 615.00,253.03 615.00,249.22 C615.00,237.74 621.18,227.58 630.73,223.36 C636.71,220.71 638.79,220.49 642.40,222.14 C644.71,223.19 648.00,228.34 648.00,230.90 C648.00,232.86 649.91,232.07 653.88,228.49 C657.96,224.80 661.00,224.62 661.00,228.07 C661.00,230.83 655.24,236.88 651.77,237.78 C649.04,238.49 648.58,239.21 647.09,245.16 C645.07,253.17 641.31,259.11 636.04,262.59 C631.30,265.73 626.61,266.03 621.08,263.54 C616.38,261.42 615.64,261.65 607.40,267.88 L 602.50 271.58 L 599.32 283.95 C593.64,306.12 589.40,315.40 583.11,319.52 C578.23,322.71 575.12,323.24 571.27,321.54 ZM 507.06 309.58 C505.24,307.38 506.26,302.74 521.68,243.23 C523.97,234.39 524.67,232.87 526.67,232.37 C529.93,231.55 532.00,232.58 532.00,235.02 C532.00,236.97 532.27,236.91 536.53,233.98 C542.69,229.74 546.49,229.75 550.29,233.99 C553.12,237.17 553.22,237.60 552.80,244.98 C551.76,262.89 539.44,277.00 524.84,277.00 C522.75,277.00 521.91,277.57 521.53,279.25 C518.06,294.72 514.83,307.44 513.98,309.03 C512.75,311.33 508.78,311.64 507.06,309.58 ZM 613.14 130.05 C628.61,128.43 635.00,125.21 635.00,119.06 C635.00,108.94 617.58,104.82 604.04,111.73 C599.64,113.97 597.94,115.58 595.77,119.53 C594.27,122.26 593.04,125.96 593.02,127.75 L 593.00 131.00 L 598.75 130.98 C601.91,130.97 608.39,130.56 613.14,130.05 ZM 315.99 128.88 C323.59,127.68 329.33,124.76 330.93,121.26 C332.27,118.32 330.17,113.96 325.87,110.75 C322.61,108.32 312.18,107.32 306.40,108.89 C298.26,111.09 291.75,117.49 290.41,124.60 C289.25,130.79 289.86,131.15 300.23,130.48 C305.33,130.16 312.42,129.44 315.99,128.88 ZM 744.03 247.78 C740.56,245.94 737.00,240.28 737.01,236.60 C737.02,230.87 741.86,225.61 748.05,224.61 C760.14,222.65 767.74,236.72 759.20,245.26 C755.69,248.77 748.24,250.01 744.03,247.78 ZM 532.14 268.00 C533.90,268.00 539.17,261.59 541.60,256.50 C543.90,251.66 544.75,244.13 543.39,240.58 C541.39,235.35 532.33,243.93 527.99,255.17 C526.35,259.44 525.00,263.83 525.00,264.92 C525.00,267.14 527.80,269.20 529.83,268.47 C530.56,268.21 531.60,268.00 532.14,268.00 ZM 580.84 310.06 C584.69,304.75 592.19,282.86 590.68,281.35 C589.73,280.40 578.10,293.05 574.93,298.50 C571.68,304.08 571.23,308.45 573.56,311.78 C575.79,314.97 577.60,314.54 580.84,310.06 ZM 632.47 254.85 C635.11,252.77 639.00,245.35 639.00,242.39 C639.00,241.60 637.93,240.55 636.63,240.05 C635.33,239.55 633.27,237.89 632.06,236.35 L 629.85 233.54 L 628.03 235.96 C624.08,241.20 622.81,250.85 625.56,254.78 C627.50,257.56 629.00,257.57 632.47,254.85 ZM 754.47 245.45 C758.85,243.37 761.75,238.01 760.46,234.39 C759.46,231.61 756.54,229.12 755.49,230.17 C755.16,230.50 754.84,233.09 754.77,235.92 L 754.66 241.06 L 751.62 240.88 C752.24,240.63 752.61,240.14 752.36,239.50 C752.05,238.68 750.93,238.00 749.89,238.00 C747.99,238.00 747.42,239.09 748.67,240.33 C748.88,240.55 749.13,240.71 749.40,240.83 C747.97,240.87 746.68,241.08 746.20,241.38 C745.32,241.92 745.00,240.52 745.00,236.06 C745.00,233.28 744.70,230.97 744.28,230.24 C745.26,230.04 746.89,230.02 749.51,230.11 C753.09,230.22 756.34,230.00 756.73,229.60 C757.99,228.34 754.62,227.03 750.06,227.02 C745.47,227.00 741.00,229.82 741.00,232.73 C741.00,233.26 741.21,233.59 741.53,233.63 C741.52,233.63 741.51,233.63 741.50,233.64 C737.98,234.99 740.86,242.77 745.89,245.50 C749.27,247.34 750.51,247.33 754.47,245.45 ZM 567.57 222.43 C564.28,219.13 567.09,214.69 572.16,215.18 C574.98,215.45 575.55,215.93 575.82,218.31 C576.00,219.86 575.61,221.77 574.95,222.56 C573.37,224.46 569.54,224.39 567.57,222.43 ZM 641.25 231.52 C640.74,228.88 639.48,228.41 637.05,229.95 C635.86,230.70 636.03,231.21 638.05,232.84 C641.01,235.23 641.89,234.87 641.25,231.52 ZM 748.00 233.50 C748.00,234.33 748.89,235.00 750.00,235.00 C751.11,235.00 752.00,234.33 752.00,233.50 C752.00,232.67 751.11,232.00 750.00,232.00 C748.89,232.00 748.00,232.67 748.00,233.50 ZM 743.07 230.98 C743.02,231.15 743.00,231.34 743.00,231.53 C743.00,231.75 742.95,231.98 742.87,232.20 C742.95,231.94 743.00,231.66 743.00,231.39 C743.00,231.24 743.02,231.10 743.07,230.98 Z" fill="rgba(30,75,56,1)"/>
<path d="M 748.67 240.33 C747.42,239.09 747.99,238.00 749.89,238.00 C750.93,238.00 752.05,238.68 752.36,239.50 C752.95,241.03 750.02,241.69 748.67,240.33 ZM 748.00 233.50 C748.00,232.67 748.89,232.00 750.00,232.00 C751.11,232.00 752.00,232.67 752.00,233.50 C752.00,234.33 751.11,235.00 750.00,235.00 C748.89,235.00 748.00,234.33 748.00,233.50 ZM 741.00 232.73 C741.00,229.82 745.47,227.00 750.06,227.02 C754.62,227.03 757.99,228.34 756.73,229.60 C756.34,230.00 753.09,230.22 749.51,230.11 C744.31,229.94 743.00,230.19 743.00,231.39 C743.00,232.21 742.55,233.16 742.00,233.50 C741.45,233.84 741.00,233.49 741.00,232.73 Z" fill="rgba(155,186,171,1)"/>
</g>
</svg>
`;

        // 7. Render Template
        overlay = document.createElement('div');
        overlay.id = 'invoice-overlay';
        overlay.style.cssText = `position: fixed; top: 0; left: 0; width: 100vw; height: 100vh; background: #333; z-index: 999999; display: flex; justify-content: center; align-items: center; overflow: auto;`;
        document.body.appendChild(overlay);

        const getInvoiceHtml = (copyTitle) => `
            <div class="invoice-half">
                <div class="inv-top"><span>Page 1 of 1</span><span>TAX INVOICE</span><span>${copyTitle} Copy</span></div>
                <div class="header-section">
                    <div class="logo-box">${svgLogo}</div>
                    <div class="company-box">
                        <h2 style="margin:0; font-size:16px;">FRESKEYPIYO BEVERAGES</h2>
                        <p>01, MAIN BAZAR, BHAGWANPUR, HARIDWAR, U.K</p>
                        <p><strong>GSTIN:</strong> 05AALFF0289R1ZS &nbsp;|&nbsp; <strong>Ph:</strong> 9876543210</p>
                    </div>
                </div>
                <div class="meta-row">
                    <div class="meta-item"><strong>Inv No:</strong> ${userSettings.invNo}</div>
                    <div class="meta-item"><strong>Date:</strong> ${displayDate}</div>
                    <div class="meta-item"><strong>Route:</strong> ${route}</div>
                    <div class="meta-item"><strong>Vehicle:</strong> ${userSettings.vehicle}</div>
                </div>
                <div class="address-section">
                    <div class="addr-box" style="border-right:1px solid #000;">
                        <div class="addr-title">Billed To:</div><strong>${custName}</strong><br>GSTIN: ${custGst}<br>Ph: ${custPhone}
                    </div>
                    <div class="addr-box"><div class="addr-title">Shipped To:</div>${userSettings.address}</div>
                </div>
                <div class="table-container">
                    <table class="inv-table">
                        <thead>
                            <tr><th width="5%">#</th><th width="45%">Item Description</th><th width="10%">HSN</th><th width="10%">Qty</th><th width="10%">Unit</th><th width="10%">Rate</th><th width="10%">Amt</th></tr>
                        </thead>
                        <tbody>
                            ${userSettings.items.map((item, i) => `
                            <tr><td align="center">${i + 1}</td><td>${item.name}</td><td align="center">2201</td><td align="center">${item.qty}</td><td align="center">Box</td><td align="right">${item.rate.toFixed(2)}</td><td align="right">${item.amount.toFixed(2)}</td></tr>
                            `).join('')}
                            ${Array(Math.max(0, 6 - userSettings.items.length)).fill(0).map(() => `<tr><td style="color:white">.</td><td></td><td></td><td></td><td></td><td></td><td></td></tr>`).join('')}
                        </tbody>
                    </table>
                </div>
                <div class="footer-section">
                    <div class="terms-box">
                        <strong>Bank Details:</strong><br>Bank: PUNB <br>A/C: 4882002100005628<br>IFSC: PUNB0488200<br><br><span style="font-size:8px;">1. Goods once sold not returnable.<br>2. Subject to Roorkee Jurisdiction.</span>
                    </div>
                    <div class="totals-box">
                        <div class="t-row"><span>Subtotal:</span> <span>${subTotal.toFixed(2)}</span></div>
                        ${discountAmount > 0 ? `<div class="t-row" style="color:#dc2626;"><span>Less Discount:</span> <span>-${discountAmount.toFixed(2)}</span></div>` : ''}
                        <div class="t-row" style="border-top:1px dashed #ccc; margin-top:2px;"><span>Taxable Value:</span> <span>${taxableValue.toFixed(2)}</span></div>
                        <div class="t-row"><span>CGST 2.5%:</span> <span>${cgst.toFixed(2)}</span></div>
                        <div class="t-row"><span>SGST 2.5%:</span> <span>${sgst.toFixed(2)}</span></div>
                        <div class="t-row final"><span>Grand Total:</span> <span>₹${Math.round(grandTotal).toFixed(2)}</span></div>
                        <div style="margin-top:15px; text-align:right; font-size:9px;"><strong>For Freskeypiyo Beverages</strong><br><br>Auth. Signatory</div>
                    </div>
                </div>
            </div>
        `;

        const wrapperId = 'print-wrapper';
        overlay.innerHTML = `
            <style>
                #print-wrapper { width: 297mm; height: 200mm; background: white; padding: 10mm; box-sizing: border-box; display: flex; justify-content: space-between; font-family: Arial, sans-serif; color: #000; }
                .invoice-half { width: 48%; height: 100%; border: 1px solid #000; display: flex; flex-direction: column; font-size: 10px; }
                .inv-top { display: flex; justify-content: space-between; border-bottom: 1px solid #000; padding: 2px 5px; font-weight: bold; font-size:9px; }
                .header-section { display: flex; border-bottom: 1px solid #000; height: 60px; }
                .logo-box { width: 25%; background: #000; display: flex; align-items: center; justify-content: center; -webkit-print-color-adjust: exact; }
                .company-box { width: 75%; text-align: center; padding: 5px; display: flex; flex-direction: column; justify-content: center; }
                .meta-row { display: flex; justify-content: space-between; padding: 4px; border-bottom: 1px solid #000; background: #f9f9f9; -webkit-print-color-adjust: exact; }
                .meta-item { font-size: 9px; }
                .address-section { display: flex; border-bottom: 1px solid #000; height: 55px; }
                .addr-box { width: 50%; padding: 4px; font-size: 10px; line-height: 1.2; overflow: hidden; }
                .addr-title { font-size: 8px; color: #666; text-transform: uppercase; font-weight: bold; }
                .table-container { flex-grow: 1; }
                .inv-table { width: 100%; border-collapse: collapse; font-size: 10px; }
                .inv-table th { background: #ddd; border-bottom: 1px solid #000; border-right: 1px solid #000; padding: 3px; text-align: center; font-weight: bold; -webkit-print-color-adjust: exact; }
                .inv-table td { border-bottom: 1px solid #ccc; border-right: 1px solid #ccc; padding: 3px 4px; }
                .inv-table td:last-child, .inv-table th:last-child { border-right: none; }
                .footer-section { display: flex; border-top: 1px solid #000; height: 105px; }
                .terms-box { width: 60%; padding: 5px; border-right: 1px solid #000; font-size: 9px; }
                .totals-box { width: 40%; padding: 5px; }
                .t-row { display: flex; justify-content: space-between; margin-bottom: 2px; font-size: 10px; }
                .t-row.final { font-weight: bold; font-size: 12px; border-top: 1px solid #000; margin-top: 2px; padding-top: 2px; background: #eee; -webkit-print-color-adjust: exact; }
            </style>
            <div id="${wrapperId}">
                ${getInvoiceHtml("ORIGINAL")}
                ${getInvoiceHtml("DUPLICATE")}
            </div>
        `;

        await new Promise(r => setTimeout(r, 800));

        const element = document.getElementById(wrapperId);
        const opt = { margin: 0, filename: `Inv_${userSettings.invNo.replace(/\//g, '-')}.pdf`, image: { type: 'jpeg', quality: 0.98 }, html2canvas: { scale: 2, useCORS: true, scrollY: 0 }, jsPDF: { unit: 'mm', format: 'a4', orientation: 'landscape' } };
        await html2pdf().set(opt).from(element).save();

    } catch (error) {
        console.error("PDF Gen Error:", error);
        alert("Failed: " + error.message);
    } finally {
        setTimeout(() => {
            if (overlay) document.body.removeChild(overlay);
            btn.disabled = false;
            btn.innerHTML = originalText;
        }, 1000);
    }
};
