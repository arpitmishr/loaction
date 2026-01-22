import { orderBy } from "https://www.gstatic.com/firebasejs/11.2.0/firebase-firestore.js";
import { onAuthStateChanged } from "https://www.gstatic.com/firebasejs/11.2.0/firebase-auth.js";
import { 
    doc, getDoc, collection, getDocs, query, where, Timestamp 
} from "https://www.gstatic.com/firebasejs/11.2.0/firebase-firestore.js";
import { auth, db } from "./firebase.js";
import { logoutUser } from "./auth.js";

const content = document.getElementById('content');
const loader = document.getElementById('loader');

// --- 1. Auth Guard ---
onAuthStateChanged(auth, async (user) => {
    if (!user) {
        window.location.href = 'index.html';
        return;
    }
    loadTodayAttendance();

    const userDoc = await getDoc(doc(db, "users", user.uid));
    if (!userDoc.exists() || userDoc.data().role !== 'admin') {
        alert("Access Denied");
        logoutUser();
        return;
    }

    if(loader) loader.style.display = 'none';
    content.style.display = 'block';
    if(document.getElementById('user-email')) 
        document.getElementById('user-email').innerText = user.email;

    // --- 2. Load Data ---
    loadDashboardStats();
    loadSalesmenList(); // Your existing function
});

document.getElementById('logoutBtn').addEventListener('click', logoutUser);


// --- CORE DASHBOARD LOGIC ---

async function loadDashboardStats() {
    try {
        // A. Define "Today" time range
        const now = new Date();
        const startOfDay = new Date(now.getFullYear(), now.getMonth(), now.getDate());
        const endOfDay = new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1);

        const startTs = Timestamp.fromDate(startOfDay);
        const endTs = Timestamp.fromDate(endOfDay);

        // B. Execute Queries in Parallel (Faster)
        const [attendanceSnap, ordersSnap, outletsSnap] = await Promise.all([
            // 1. Get Attendance for today
            getDocs(query(
                collection(db, "attendance"),
                where("checkInTime", ">=", startTs),
                where("checkInTime", "<", endTs)
            )),
            // 2. Get Orders for today
            getDocs(query(
                collection(db, "orders"),
                where("orderDate", ">=", startTs),
                where("orderDate", "<", endTs)
            )),
            // 3. Get ALL Outlets (for credit sum)
            getDocs(collection(db, "outlets"))
        ]);

        // C. Process 1: Attendance Count
        const attendanceCount = attendanceSnap.size;

        // D. Process 2: Sales & Orders
        let totalOrders = ordersSnap.size;
        let totalSales = 0;
        
        ordersSnap.forEach(doc => {
            const data = doc.data();
            // Ensure we handle strings or numbers safely
            totalSales += Number(data.totalAmount) || 0;
        });

        // E. Process 3: Outstanding Credit
        let totalCredit = 0;
        outletsSnap.forEach(doc => {
            const data = doc.data();
            // Assuming positive balance means they owe us money
            totalCredit += Number(data.currentBalance) || 0;
        });

        // F. Update UI
        document.getElementById('stat-attendance').innerText = attendanceCount;
        document.getElementById('stat-orders').innerText = totalOrders;
        document.getElementById('stat-sales').innerText = formatCurrency(totalSales);
        document.getElementById('stat-credit').innerText = formatCurrency(totalCredit);

    } catch (error) {
        console.error("Error loading stats:", error);
    }
}

// Utility: Format Number as Currency
function formatCurrency(amount) {
    return new Intl.NumberFormat('en-US', {
        style: 'currency',
        currency: 'USD' // Change to 'INR' for Rupees
    }).format(amount);
}

// Your existing list function (kept for reference)
async function loadSalesmenList() {
    const list = document.getElementById('salesmen-list');
    if(!list) return;
    list.innerHTML = '';

    const q = query(collection(db, "users"), where("role", "==", "salesman"));
    const snap = await getDocs(q);
    
    if(snap.empty) { list.innerHTML = "<li>No salesmen found.</li>"; return; }

    snap.forEach(doc => {
        const d = doc.data();
        const li = document.createElement('li');
        li.textContent = `👤 ${d.fullName || d.email}`;
        list.appendChild(li);
    });
}


async function loadTodayAttendance() {
    const list = document.getElementById('attendance-list');
    
    // Helper to get today's YYYY-MM-DD
    const d = new Date();
    const todayStr = d.getFullYear() + "-" + 
           String(d.getMonth() + 1).padStart(2, '0') + "-" + 
           String(d.getDate()).padStart(2, '0');

    try {
        // Query: Date == Today
        const q = query(
            collection(db, "attendance"),
            where("date", "==", todayStr),
            orderBy("checkInTime", "desc") // Show newest first
        );

        const snap = await getDocs(q);
        list.innerHTML = "";

        if (snap.empty) {
            list.innerHTML = "<tr><td colspan='3' style='padding:15px; text-align:center'>No check-ins yet today.</td></tr>";
            return;
        }

        snap.forEach(doc => {
            const data = doc.data();
            const time = data.checkInTime.toDate().toLocaleTimeString([], {hour: '2-digit', minute:'2-digit'});
            
            // Create Google Maps Link
            const lat = data.location.latitude;
            const lng = data.location.longitude;
            const mapUrl = `https://www.google.com/maps/search/?api=1&query=${lat},${lng}`;

            const row = `
                <tr style="border-bottom: 1px solid #eee;">
                    <td style="padding: 10px;">${data.salesmanEmail || 'Unknown'}</td>
                    <td>${time}</td>
                    <td><a href="${mapUrl}" target="_blank" style="color: #007bff; text-decoration: none;">View 📍</a></td>
                </tr>
            `;
            list.innerHTML += row;
        });

    } catch (error) {
        console.error("Error loading attendance:", error);
        // If index error, show helpful message
        if(error.message.includes("index")) {
            list.innerHTML = "<tr><td colspan='3' style='color:red'>Missing Index. Check Console.</td></tr>";
        }
    }
}
