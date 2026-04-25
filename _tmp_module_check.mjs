
import{initializeApp}from"https://www.gstatic.com/firebasejs/12.12.0/firebase-app.js";
import{getAuth,GoogleAuthProvider,signInWithPopup,createUserWithEmailAndPassword,signInWithEmailAndPassword,sendEmailVerification,sendPasswordResetEmail,sendSignInLinkToEmail,isSignInWithEmailLink,signInWithEmailLink,updateProfile,onAuthStateChanged,signOut}from"https://www.gstatic.com/firebasejs/12.12.0/firebase-auth.js";
import{getFirestore,collection,doc,setDoc,getDoc,updateDoc,onSnapshot,addDoc,query,orderBy,getDocs,serverTimestamp,where}from"https://www.gstatic.com/firebasejs/12.12.0/firebase-firestore.js";
import{getStorage,ref,uploadBytes,getDownloadURL}from"https://www.gstatic.com/firebasejs/12.12.0/firebase-storage.js";

const FB=initializeApp({apiKey:"AIzaSyCtRp3ydaReZEb7RQcjf4tnYraPJWlh2UE",authDomain:"bike-rental-mvp-eb787.firebaseapp.com",projectId:"bike-rental-mvp-eb787",storageBucket:"bike-rental-mvp-eb787.firebasestorage.app",messagingSenderId:"850320602989",appId:"1:850320602989:web:097722db77cd494704cc64"});
const auth=getAuth(FB);
const db=getFirestore(FB);
const storage=getStorage(FB);

/* ════ GLOBALS ════ */
let currentUser=null,currentProfileUrl=null,selBike=null,selSlot=0,selStar=4,curFilter='all',curSearch='',leafMap=null,userMarker=null,bikeMarkers={},dmgCurStep=1,dmgSeverity='minor',dmgPhotos=[],latestDamageReportId=null,ownerListings=[],riderBookings=[],ownerBookings=[],withdrawalRequests=[],damageReports=[],damageBikeChoices=[],selectedListingId=null,liveUnsubs=[];
const API_BASE_URL=(window.localStorage.getItem('rideshareApiBaseUrl')||'http://3.110.190.230').replace(/\/$/,'');

async function apiRequest(path,{method='GET',body,headers={}}={}){
  const token=auth.currentUser?await auth.currentUser.getIdToken():null;
  const opts={method,headers:{...headers}};
  if(token)opts.headers.Authorization=`Bearer ${token}`;
  if(body!==undefined){
    opts.headers['Content-Type']='application/json';
    opts.body=JSON.stringify(body);
  }
  const resp=await fetch(`${API_BASE_URL}${path}`,opts);
  const isJson=(resp.headers.get('content-type')||'').includes('application/json');
  const data=isJson?await resp.json():null;
  if(!resp.ok)throw new Error(data?.error||`Request failed with status ${resp.status}`);
  return data;
}

const callableProxy=path=>async payload=>({data:await apiRequest(path,{method:'POST',body:payload})});
const createUploadSessionFn=callableProxy('/upload/create-session');
const finalizeUploadFn=callableProxy('/upload/finalize');
const createBookingOrderFn=callableProxy('/payments/booking/create-order');
const verifyBookingPaymentFn=callableProxy('/payments/booking/verify');
const createDamagePaymentOrderFn=callableProxy('/payments/damage/create-order');
const verifyDamagePaymentFn=callableProxy('/payments/damage/verify');
const saveBankAccountFn=callableProxy('/bank/save');
const requestWithdrawalFn=callableProxy('/withdrawals/request');

async function uploadPrivateFile(file,purpose,docType){
  const{data:uploadData}=await createUploadSessionFn({purpose,docType,mimeType:file.type,size:file.size,fileName:file.name});
  const resp=await fetch(uploadData.uploadUrl,{method:'PUT',headers:{'Content-Type':file.type},body:file});
  if(!resp.ok)throw new Error(`Upload failed with status ${resp.status}`);
  const{data:finalized}=await finalizeUploadFn({uploadId:uploadData.uploadId});
  return{uploadId:uploadData.uploadId,s3Key:uploadData.s3Key||uploadData.key,status:finalized.status,fileName:file.name,mimeType:file.type,size:file.size};
}

function formatCurrency(value){
  return`₹${Number(value||0).toFixed(2)}`;
}

function toDateObject(value){
  if(!value)return null;
  if(typeof value.toDate==='function')return value.toDate();
  if(typeof value?.seconds==='number')return new Date(value.seconds*1000);
  if(typeof value==='string'||typeof value==='number'){const date=new Date(value);return Number.isNaN(date.getTime())?null:date;}
  return null;
}

function compareByCreatedDesc(a,b){
  return(toDateObject(b.createdAt)||0)-(toDateObject(a.createdAt)||0);
}

function clearLiveWatchers(){
  liveUnsubs.forEach(unsub=>{try{unsub();}catch(e){}});
  liveUnsubs=[];
}

function trackSnapshot(ref,onNext){
  const unsub=onSnapshot(ref,onNext,()=>{});
  liveUnsubs.push(unsub);
  return unsub;
}

async function ensureBackendBootstrap(){
  try{await apiRequest('/bootstrap',{method:'POST'});}catch(e){console.warn('Bootstrap skipped:',e?.message||e);}
}

function buildFullName(profileData,user){
  return profileData?.fullName||user?.displayName||user?.email?.split('@')[0]||'User';
}

function updateVerificationBadge(profileData={}){
  const badge=document.getElementById('sf-badge-text');
  if(!badge)return;
  const statuses=['aadhaar','license','selfie','address'].map(type=>profileData?.kyc?.[type]?.status||'missing');
  const verified=statuses.length&&statuses.every(status=>status==='approved');
  badge.textContent=verified?'Verified User':'Verification pending';
}

function applyUserDocument(profileData={}){
  if(!currentUser)return;
  applyKycState(profileData.kyc||{});
  updateVerificationBadge(profileData);
  const fullName=buildFullName(profileData,currentUser);
  document.getElementById('sf-name').textContent=fullName;
  document.getElementById('amh-name').textContent=fullName;
  document.getElementById('prof-name').value=fullName;
  document.getElementById('prof-display').value=profileData.displayName||currentUser.displayName||fullName;

  document.getElementById('prof-city').value=profileData.city||'';
  document.getElementById('prof-phone').value=profileData.phone||'';
  document.getElementById('ec-name').value=profileData.emergencyContact?.name||'';
  document.getElementById('ec-phone').value=profileData.emergencyContact?.phone||'';
  document.getElementById('ec-email').value=profileData.emergencyContact?.email||'';
  document.getElementById('ec-relationship').value=profileData.emergencyContact?.relationship||'Family';

  const settings=profileData.settings||{};
  document.getElementById('toggle-gps').checked=settings.gps!==false;
  document.getElementById('toggle-sms').checked=settings.sms!==false;
  document.getElementById('toggle-sos').checked=!!settings.sos;
  document.getElementById('toggle-dmg').checked=settings.damage_alert!==false;
  document.getElementById('toggle-receipt').checked=settings.receipts!==false;

  document.getElementById('bank-name').value=profileData.bankAccount?.holderName||'';
  document.getElementById('bank-acc').value=profileData.bankAccount?.accountNumber||'';
  document.getElementById('bank-ifsc').value=profileData.bankAccount?.ifsc||'';
  document.getElementById('bank-bank').value=profileData.bankAccount?.bankName||'';
  document.getElementById('bank-upi').value=profileData.bankAccount?.upi||'';
}

function getBookingState(booking){
  const createdAt=toDateObject(booking.createdAt);
  const ageMs=createdAt?Date.now()-createdAt.getTime():0;
  if(['cancelled','completed','done'].includes(booking.status))return'past';
  if(booking.paymentStatus==='created'||booking.status==='pending_payment')return'upcoming';
  if(ageMs>1000*60*60*12)return'past';
  return'active';
}

function getDamageEstimate(severity){
  if(severity==='severe')return{repair:4200,service:450,label:'Accident / severe damage'};
  if(severity==='moderate')return{repair:1650,service:250,label:'Body damage / replacement'};
  return{repair:525,service:75,label:'Minor scratch / dent'};
}

function createTxnRow(txn){
  const icon=txn.kind==='withdrawal'
    ? '<svg width="14" height="14" viewBox="0 0 24 24" fill="none"><path d="M12 2v20M17 5H9.5a3.5 3.5 0 100 7h5a3.5 3.5 0 110 7H6" stroke="var(--brand)" stroke-width="1.8" stroke-linecap="round"/></svg>'
    : txn.amount<0
      ? '<svg width="14" height="14" viewBox="0 0 24 24" fill="none"><path d="M17 7L7 17M7 7l10 10" stroke="#ef4444" stroke-width="2" stroke-linecap="round"/></svg>'
      : '<svg width="14" height="14" viewBox="0 0 24 24" fill="none"><path d="M7 17L17 7M17 7H7M17 7v10" stroke="#22c55e" stroke-width="2" stroke-linecap="round"/></svg>';
  const bg=txn.kind==='withdrawal'?'var(--brand-s)':txn.amount<0?'var(--err-s)':'var(--green-s)';
  const cls=txn.amount<0?'db':'cr';
  const prefix=txn.amount<0?'-':'+';  
  return`<div class="txn-row"><div class="txn-ic" style="background:${bg};">${icon}</div><div class="txn-info"><div class="txn-name">${txn.title}</div><div class="txn-date">${txn.meta}</div></div><div class="txn-amt ${cls}">${prefix}${formatCurrency(Math.abs(txn.amount))}</div></div>`;
}

function showBookingSuccess(bookingId,total){
  document.getElementById('book-msg').textContent=`Your ${selBike.name} is booked for ${selBike.slots[selSlot]?.t||'selected slot'}. Meet ${selBike.owner} at the pickup location.`;
  document.getElementById('book-id').textContent='#'+bookingId;
  document.getElementById('book-amt').textContent='₹'+total.toFixed(2);
  openModal('modal-book');toast('Booking confirmed! 🎉','ok');
}

function applyKycState(kycData={}){
  ['aadhaar','license','selfie','address'].forEach((type)=>{
    const statusEl=document.getElementById(`kyc-${type}-status`);
    const entry=kycData?.[type];
    if(!statusEl)return;
    if(entry?.status==='approved'){
      statusEl.className='kyc-status done';
      statusEl.textContent='✓ Verified';
    }else if(['pending_review','pending','uploaded'].includes(entry?.status)){
      statusEl.className='kyc-status pend';
      statusEl.textContent='⏳ Under verification';
    }else{
      statusEl.className='kyc-status req';
      statusEl.textContent='✕ Not uploaded';
    }
  });
}

function renderBookingCard(booking,section){
  const createdAt=toDateObject(booking.createdAt);
  const when=createdAt?createdAt.toLocaleString('en-IN',{day:'numeric',month:'short',hour:'numeric',minute:'2-digit'}):'Recently';
  const accent=section==='active'?'var(--brand-s)':section==='upcoming'?'var(--green-s)':(booking.color||'#F3E5F5');
  const statusClass=section==='active'?'active':section==='upcoming'?'upcoming':'done';
  const statusLabel=section==='active'?'● Active now':section==='upcoming'?'Payment pending':'Completed';
  const actions=section==='past'
    ? `<button class="bk-btn prim" onclick="openRatingModal('${booking.bikeName||'Ride'}','${booking.owner||'Owner'}')">⭐ Rate this ride</button><button class="bk-btn ghost" onclick="navTo('damage')">Report issue</button>`
    : `<button class="bk-btn ghost" onclick="contactOwner('${booking.owner||'Owner'}')">📞 Contact owner</button>`;
  return`<div class="bk-card"><div class="bk-ic" style="background:${accent};"><svg width="20" height="20" viewBox="0 0 24 24" fill="none"><ellipse cx="6" cy="17" rx="4" ry="4" stroke="#1565C0" stroke-width="2"/><ellipse cx="18" cy="17" rx="4" ry="4" stroke="#1565C0" stroke-width="2"/><path d="M6 17L10 8h4l4 9" stroke="#1565C0" stroke-width="2"/></svg></div><div class="bk-info"><div class="bk-name">${booking.bikeName||'Bike booking'}</div><div class="bk-meta">${when} · ${booking.slot||'Time slot pending'} · ${booking.owner||'Owner pending'}<br/>Booking #${booking.id} · Paid: ${formatCurrency(booking.total||0)}</div><div class="bk-status ${statusClass}">${statusLabel}</div><div class="bk-actions">${actions}</div></div></div>`;
}

function loadBookingsRealtime(){
  if(!currentUser)return;
  const activeEl=document.getElementById('bookings-active-list');
  const upcomingEl=document.getElementById('bookings-upcoming-list');
  const pastEl=document.getElementById('bookings-past-list');
  trackSnapshot(query(collection(db,'bookings'),where('userId','==',currentUser.uid)),snap=>{
    riderBookings=snap.docs.map(d=>({id:d.id,...d.data()})).sort(compareByCreatedDesc);
    const active=riderBookings.filter(b=>getBookingState(b)==='active');
    const upcoming=riderBookings.filter(b=>getBookingState(b)==='upcoming');
    const past=riderBookings.filter(b=>getBookingState(b)==='past');
    activeEl.innerHTML=active.length?active.map(b=>renderBookingCard(b,'active')).join(''):'<div class="card-box" style="font-size:12px;color:var(--txt2);">No active rides yet.</div>';
    upcomingEl.innerHTML=upcoming.length?upcoming.map(b=>renderBookingCard(b,'upcoming')).join(''):'<div class="card-box" style="font-size:12px;color:var(--txt2);">No upcoming rides.</div>';
    pastEl.innerHTML=past.length?past.map(b=>renderBookingCard(b,'past')).join(''):'<div class="card-box" style="font-size:12px;color:var(--txt2);">No past rides yet.</div>';
    populateDamageBikeOptions();
  });
}

function loadUserRealtime(){
  if(!currentUser)return;
  trackSnapshot(doc(db,'users',currentUser.uid),snap=>{
    applyUserDocument(snap.exists()?snap.data():{});
  });
}

function renderListings(){
  const listEl=document.getElementById('listings-list');
  if(!listEl)return;
  const visibleListings=ownerListings.filter(listing=>!listing.archived);
  if(!selectedListingId&&visibleListings[0])selectedListingId=visibleListings[0].id;
  if(selectedListingId&&!visibleListings.some(listing=>listing.id===selectedListingId))selectedListingId=visibleListings[0]?.id||null;

  if(!visibleListings.length){
    listEl.innerHTML='<div class="card-box" style="font-size:12px;color:var(--txt2);">No bikes listed yet. Add your first bike to start earning.</div>';
    document.getElementById('listing-schedule-title').textContent='Availability schedule';
    return;
  }

  listEl.innerHTML=visibleListings.map(listing=>{
    const rides=ownerBookings.filter(booking=>booking.bikeId===listing.id&&booking.paymentStatus==='captured');
    const earned=rides.reduce((sum,booking)=>sum+Math.max((booking.price||0)-(booking.platformFee||0),0),0);
    const schedule=listing.schedule||{};
    const scheduleLabel=`${(schedule.days||[]).join(', ')||'Custom'} · ${schedule.from||'09:00'}-${schedule.to||'17:00'}`;
    const activeAttr=listing.active!==false?'checked':'';
    const selectedStyle=listing.id===selectedListingId?'box-shadow:0 0 0 1px rgba(21,101,192,.45) inset;':'';
    return`<div class="list-card" style="${selectedStyle}" onclick="selectListing('${listing.id}')"><div class="list-img" style="background:${listing.color||'var(--brand-s)'};">${bikeSVG(listing.stroke||'#1565C0',38,22)}</div><div class="list-info"><div class="list-name">${listing.name}</div><div class="list-meta">${formatCurrency(listing.price||0)}/hr · ${scheduleLabel} · ${rides.length} rides · ${formatCurrency(earned)} earned (after fee)</div></div><label class="tswitch" onclick="event.stopPropagation()"><input type="checkbox" ${activeAttr} onchange="toggleListing('${listing.id}',this.checked)"/><span class="tslider"></span></label><div class="list-actions"><button class="list-btn edit" onclick="event.stopPropagation();openEditListing('${listing.id}')">Edit</button><button class="list-btn del" onclick="event.stopPropagation();deleteListing('${listing.id}')">Remove</button></div></div>`;
  }).join('');

  renderListingScheduleForm();
  populateDamageBikeOptions();
}

function renderListingScheduleForm(){
  const listing=ownerListings.find(item=>item.id===selectedListingId&&!item.archived);
  const title=document.getElementById('listing-schedule-title');
  if(!listing){
    title.textContent='Availability schedule';
    document.querySelectorAll('#day-grid .day-btn').forEach(btn=>btn.classList.remove('on'));
    document.getElementById('avail-from').value='09:00';
    document.getElementById('avail-to').value='17:00';
    document.getElementById('min-duration-select').value='1 hour';
    document.getElementById('schedule-price-input').value='35';
    return;
  }
  const schedule=listing.schedule||{};
  title.textContent=`Availability schedule — ${listing.name}`;
  document.querySelectorAll('#day-grid .day-btn').forEach(btn=>{
    btn.classList.toggle('on',(schedule.days||[]).includes(btn.textContent.trim()));
  });
  document.getElementById('avail-from').value=schedule.from||'09:00';
  document.getElementById('avail-to').value=schedule.to||'17:00';
  document.getElementById('min-duration-select').value=schedule.minimumDuration||'1 hour';
  document.getElementById('schedule-price-input').value=listing.price||35;
}

function renderEarnings(){
  const captured=ownerBookings.filter(booking=>booking.paymentStatus==='captured');
  const credits=captured.map(booking=>{
    const amount=Math.max((booking.price||0)-(booking.platformFee||0),0);
    return{amount,createdAt:booking.createdAt,booking};
  });
  const now=new Date();
  const monthStart=new Date(now.getFullYear(),now.getMonth(),1);
  const weekStart=new Date(now.getTime()-7*24*60*60*1000);
  const totalMonth=credits.filter(item=>(toDateObject(item.createdAt)||now)>=monthStart).reduce((sum,item)=>sum+item.amount,0);
  const thisWeek=credits.filter(item=>(toDateObject(item.createdAt)||now)>=weekStart).reduce((sum,item)=>sum+item.amount,0);
  const withdrawn=withdrawalRequests.reduce((sum,request)=>sum+Number(request.amount||0),0);
  const pending=Math.max(credits.reduce((sum,item)=>sum+item.amount,0)-withdrawn,0);

  document.getElementById('earn-total').textContent=formatCurrency(totalMonth);
  document.getElementById('earn-week').textContent=formatCurrency(thisWeek);
  document.getElementById('earn-pending').textContent=formatCurrency(pending);
  document.getElementById('earn-withdrawn').textContent=formatCurrency(withdrawn);
  document.getElementById('earn-sub').textContent=`${captured.length} rides · 8% platform fee deducted · Powered by Razorpay`;
  document.getElementById('withdraw-btn').textContent=`Withdraw ${formatCurrency(pending)} to bank`;

  const txns=[];
  captured.forEach(booking=>{
    const ownerCredit=Math.max((booking.price||0)-(booking.platformFee||0),0);
    txns.push({
      id:`ride-${booking.id}`,
      amount:ownerCredit,
      title:`Ride rental — ${booking.bikeName||'Bike booking'}`,
      meta:`${(toDateObject(booking.createdAt)||new Date()).toLocaleString('en-IN',{day:'numeric',month:'short',hour:'numeric',minute:'2-digit'})} · ${booking.slot||'Slot pending'} · Renter: ${booking.userName||'Renter'}`,
      createdAt:booking.createdAt,
      kind:'credit'
    });
    if(booking.platformFee){
      txns.push({
        id:`fee-${booking.id}`,
        amount:-Math.abs(Number(booking.platformFee||0)),
        title:'Platform fee deducted',
        meta:`${booking.bikeName||'Bike'} · 8% commission`,
        createdAt:booking.createdAt,
        kind:'fee'
      });
    }
  });
  withdrawalRequests.forEach(request=>{
    const bankName=request.bankAccount?.bankName||'Bank account';
    const accountTail=(request.bankAccount?.accountNumber||'').slice(-4);
    txns.push({
      id:`wd-${request.id}`,
      amount:-Math.abs(Number(request.amount||0)),
      title:`Withdrawal to ${bankName}${accountTail?` ****${accountTail}`:''}`,
      meta:`${request.status||'pending'} · payout request`,
      createdAt:request.createdAt,
      kind:'withdrawal'
    });
  });
  txns.sort((a,b)=>compareByCreatedDesc(a,b));
  document.getElementById('txn-list').innerHTML=txns.length?txns.map(createTxnRow).join(''):'<div style="padding:14px 0;font-size:12px;color:var(--txt2);">No transactions yet. Your ride credits will appear here once someone books your bike.</div>';
}

function populateDamageBikeOptions(){
  const select=document.getElementById('dmg-bike-sel');
  if(!select)return;
  const listingChoices=ownerListings.filter(listing=>!listing.archived).map(listing=>({id:listing.id,label:`${listing.name} — My listing`,ownerUid:currentUser?.uid||null,source:'listing'}));
  const bookingChoices=riderBookings.map(booking=>({id:booking.bikeId||booking.id,label:`${booking.bikeName||'Bike'} — ${booking.slot||'Booked ride'} (${booking.owner||'Owner'})`,ownerUid:booking.ownerUid||null,source:'booking'}));
  damageBikeChoices=[...listingChoices,...bookingChoices].filter((choice,index,array)=>choice.id&&array.findIndex(item=>item.id===choice.id&&item.source===choice.source)===index);
  select.innerHTML='<option value="">Select the bike</option>'+damageBikeChoices.map(choice=>`<option value="${choice.id}">${choice.label}</option>`).join('');
}

function loadOwnerDataRealtime(){
  if(!currentUser)return;
  trackSnapshot(query(collection(db,'bikes'),where('ownerUid','==',currentUser.uid)),snap=>{
    ownerListings=snap.docs.map(d=>({id:d.id,...d.data()})).sort((a,b)=>(a.name||'').localeCompare(b.name||''));
    renderListings();
    renderEarnings();
  });
  trackSnapshot(query(collection(db,'bookings'),where('ownerUid','==',currentUser.uid)),snap=>{
    ownerBookings=snap.docs.map(d=>({id:d.id,...d.data()})).sort(compareByCreatedDesc);
    renderListings();
    renderEarnings();
  });
  trackSnapshot(query(collection(db,'withdrawal_requests'),where('userId','==',currentUser.uid)),snap=>{
    withdrawalRequests=snap.docs.map(d=>({id:d.id,...d.data()})).sort(compareByCreatedDesc);
    renderEarnings();
  });
  trackSnapshot(query(collection(db,'damage_reports'),where('userId','==',currentUser.uid)),snap=>{
    damageReports=snap.docs.map(d=>({id:d.id,...d.data()})).sort(compareByCreatedDesc);
    if(damageReports[0])latestDamageReportId=damageReports[0].id;
  });
}

/* ════ BIKE DATA (seeded into Firestore once) ════ */
const BIKES_SEED=[
  {id:'bike1',name:'Honda Activa 6G',owner:'Rahul K.',ownerPhone:'+91 98765 43210',dist:0.4,price:35,lat:12.8980,lng:80.0040,avail:true,color:'#E3F2FD',stroke:'#1565C0',conds:['Clean','Full tank'],warn:['Minor scratch (left side)'],slots:[{t:'9–10 AM',taken:true},{t:'10–11 AM',taken:true},{t:'11–12 PM',taken:false},{t:'12–1 PM',taken:false},{t:'1–2 PM',taken:false},{t:'2–3 PM',taken:false}]},
  {id:'bike2',name:'TVS Jupiter Classic',owner:'Priya S.',ownerPhone:'+91 98765 43211',dist:0.7,price:28,lat:12.8965,lng:80.0062,avail:true,color:'#E8F5E9',stroke:'#2E7D32',conds:['Clean','Full tank','No scratches'],warn:[],slots:[{t:'9–10 AM',taken:false},{t:'10–11 AM',taken:false},{t:'11–12 PM',taken:false},{t:'12–1 PM',taken:false},{t:'1–2 PM',taken:true},{t:'2–3 PM',taken:true}]},
  {id:'bike3',name:'Bajaj Chetak Electric',owner:'Adel M.',ownerPhone:'+91 98765 43212',dist:1.1,price:40,lat:12.8995,lng:80.0028,avail:false,color:'#FFF8E1',stroke:'#F57F17',conds:['Fully charged'],warn:['Busy till 2 PM'],slots:[{t:'9–10 AM',taken:true},{t:'10–11 AM',taken:true},{t:'11–12 PM',taken:true},{t:'12–1 PM',taken:true},{t:'2–3 PM',taken:false},{t:'3–4 PM',taken:false}]},
  {id:'bike4',name:'Hero Splendor Plus',owner:'Nadheem R.',ownerPhone:'+91 98765 43213',dist:0.9,price:22,lat:12.8950,lng:80.0055,avail:true,color:'#F3E5F5',stroke:'#6A1B9A',conds:['Clean'],warn:['Old tyres'],slots:[{t:'9–10 AM',taken:false},{t:'10–11 AM',taken:false},{t:'11–12 PM',taken:false},{t:'12–1 PM',taken:false},{t:'1–2 PM',taken:false},{t:'2–3 PM',taken:false}]},
  {id:'bike5',name:'Royal Enfield Classic 350',owner:'Vikram S.',ownerPhone:'+91 98765 43214',dist:1.8,price:80,lat:12.8935,lng:80.0070,avail:true,color:'#FCE4EC',stroke:'#C62828',conds:['Polished','Full tank'],warn:[],slots:[{t:'9–10 AM',taken:false},{t:'10–11 AM',taken:false},{t:'12–1 PM',taken:false},{t:'1–2 PM',taken:false},{t:'3–4 PM',taken:false},{t:'4–5 PM',taken:false}]},
  {id:'bike6',name:'Yamaha FZ-S V3',owner:'Kiran M.',ownerPhone:'+91 98765 43215',dist:0.6,price:45,lat:12.8970,lng:80.0020,avail:true,color:'#E0F2F1',stroke:'#00695C',conds:['Clean','Full tank'],warn:[],slots:[{t:'9–10 AM',taken:false},{t:'10–11 AM',taken:false},{t:'11–12 PM',taken:true},{t:'1–2 PM',taken:false},{t:'2–3 PM',taken:false},{t:'3–4 PM',taken:false}]}
];

/* ════ UTILS ════ */
const LS=['ls-land','ls-register','ls-reg-otp','ls-set-pass','ls-otp-signin','ls-otp-sent','ls-forgot','ls-reset-sent','ls-google','ls-role'];
function lshow(id){LS.forEach(s=>{const e=document.getElementById(s);if(e)e.className='lscreen'+(s===id?' active':'');});if(id==='ls-land'){epOpen=false;document.getElementById('ep-fields').classList.remove('open');document.getElementById('ep-chev').style.transform='';document.getElementById('ep-label').textContent='Email or Phone Number';}}
window.toast=function(msg,type='info'){const t=document.getElementById('toast');t.textContent=msg;t.className='toast '+type+' show';setTimeout(()=>t.classList.remove('show'),3400);};
function setErr(id,m){const e=document.getElementById(id);if(e)e.textContent=m;}
function clrErr(id){setErr(id,'');}
function setLd(ldId,btnId,on){const l=document.getElementById(ldId),b=document.getElementById(btnId);if(l)l.style.display=on?'block':'none';if(b)b.disabled=on;}
function fmsg(c){return({'auth/email-already-in-use':'This email is already registered.','auth/invalid-email':'Invalid email address.','auth/weak-password':'Password needs 6+ characters.','auth/wrong-password':'Incorrect password.','auth/user-not-found':'No account found. Create one?','auth/too-many-requests':'Too many attempts. Please wait.','auth/invalid-credential':'Incorrect email or password.','auth/network-request-failed':'Network error.','auth/popup-closed-by-user':'Google sign-in was cancelled.'}[c]||'Something went wrong. Try again.');}

/* OTP boxes */
function initOtp(rowId){const bs=[...document.getElementById(rowId).querySelectorAll('.lob')];bs.forEach((b,i)=>{b.addEventListener('input',()=>{b.classList.toggle('fi',b.value!=='');if(b.value&&i<bs.length-1)bs[i+1].focus();});b.addEventListener('keydown',e=>{if(e.key==='Backspace'&&!b.value&&i>0){bs[i-1].focus();bs[i-1].value='';bs[i-1].classList.remove('fi');}});b.addEventListener('paste',e=>{const d=e.clipboardData.getData('text').replace(/\D/g,'').slice(0,6);if(!d)return;e.preventDefault();[...d].forEach((ch,j)=>{if(bs[j]){bs[j].value=ch;bs[j].classList.add('fi');}});bs[Math.min(d.length,bs.length-1)].focus();});});}
function getOtp(rowId){return[...document.getElementById(rowId).querySelectorAll('.lob')].map(b=>b.value).join('');}
function clrOtp(rowId){document.getElementById(rowId).querySelectorAll('.lob').forEach(b=>{b.value='';b.classList.remove('fi');});}

/* Timer */
const _t={};
function startTimer(id,s=120){if(_t[id])clearInterval(_t[id]);let r=s;const tick=()=>{const el=document.getElementById(id);if(!el)return;const m=Math.floor(r/60),sec=r%60;el.textContent=`${m}:${sec<10?'0':''}${sec}`;if(r===0){clearInterval(_t[id]);el.textContent='Expired';}r--;};tick();_t[id]=setInterval(tick,1000);}

/* Slide / eye */
let epOpen=false;
document.getElementById('ep-toggle').addEventListener('click',()=>{epOpen=!epOpen;document.getElementById('ep-fields').classList.toggle('open',epOpen);document.getElementById('ep-chev').style.transform=epOpen?'rotate(180deg)':'';document.getElementById('ep-label').textContent=epOpen?'Hide':'Email or Phone Number';});
document.getElementById('eye-main').addEventListener('click',()=>{const e=document.getElementById('pass-inp');e.type=e.type==='password'?'text':'password';});

window.toggleP=id=>{const e=document.getElementById(id);if(e)e.type=e.type==='password'?'text':'password';};
window.chkStr=v=>{let s=0;if(v.length>=8)s++;if(/[A-Z]/.test(v)&&/[0-9]/.test(v))s++;if(/[^A-Za-z0-9]/.test(v))s++;const cl=['','w','m','s'],ms=['Enter a password to see strength','Weak','Medium — add a symbol','Strong ✓'];[1,2,3].forEach(i=>{const e=document.getElementById('sb'+i);if(e)e.className='lsb'+(s>=i?' '+cl[s]:'');});const h=document.getElementById('pw-hint');if(h)h.textContent=v.length?ms[s]:ms[0];};
window.pickRole=(a,b)=>{document.getElementById(a).className='lrole sel';document.getElementById(b).className='lrole';};

/* ════ ENTER APP ════ */
async function enterApp(user){
  currentUser=user;
  document.getElementById('page-login').style.display='none';
  document.getElementById('page-app').style.display='flex';
  
  /* Load user profile from Firestore */
  let profileData={};
  try{
    const ud=await getDoc(doc(db,'users',user.uid));
    if(ud.exists())profileData=ud.data();
  }catch(e){}
  
  const displayName=profileData.displayName||user.displayName||user.email?.split('@')[0]||'User';
  const fullName=profileData.fullName||user.displayName||displayName;
  const email=user.email||'';
  const photoURL=profileData.photoURL||user.photoURL||null;
  currentProfileUrl=photoURL;
  
  const initials=fullName.split(' ').filter(Boolean).map(w=>w[0]).join('').toUpperCase().slice(0,2)||'U';
  
  /* Topbar avatar */
  const av=document.getElementById('user-avatar');
  const ai=document.getElementById('avatar-initials');
  if(photoURL){av.style.background='transparent';ai.outerHTML=`<img src="${photoURL}" id="avatar-initials" style="width:100%;height:100%;object-fit:cover;border-radius:50%;"/>`;}
  else{ai.textContent=initials;av.style.background='rgba(255,255,255,0.25)';}
  
  /* Avatar menu */
  document.getElementById('amh-name').textContent=fullName;
  document.getElementById('amh-email').textContent=email;
  
  /* Sidebar */
  const sfa=document.getElementById('sf-avatar');
  const sfi=document.getElementById('sf-initials');
  if(photoURL){sfa.innerHTML=`<img src="${photoURL}" style="width:100%;height:100%;object-fit:cover;border-radius:50%;"/>`;}
  else{sfi.textContent=initials;}
  document.getElementById('sf-name').textContent=fullName;
  
  /* Profile modal */
  document.getElementById('prof-name').value=fullName;
  document.getElementById('prof-display').value=displayName;
  document.getElementById('prof-email-inp').value=email;
  document.getElementById('prof-city').value=profileData.city||'';
  document.getElementById('prof-phone').value=profileData.phone||'';
  applyKycState(profileData.kyc||{});
  document.getElementById('bank-name').value=profileData.bankAccount?.holderName||'';
  document.getElementById('bank-acc').value=profileData.bankAccount?.accountNumber||'';
  document.getElementById('bank-ifsc').value=profileData.bankAccount?.ifsc||'';
  document.getElementById('bank-bank').value=profileData.bankAccount?.bankName||'';
  document.getElementById('bank-upi').value=profileData.bankAccount?.upi||'';
  const pci=document.getElementById('ppc-initials');
  if(photoURL)pci.outerHTML=`<img src="${photoURL}" id="ppc-initials" style="width:100%;height:100%;object-fit:cover;border-radius:50%;"/>`;
  else pci.textContent=initials;
  
  /* Create user doc if missing */
  try{
    await setDoc(doc(db,'users',user.uid),{email,displayName,fullName,uid:user.uid,createdAt:serverTimestamp()},{merge:true});
  }catch(e){}
  
  toast(`Welcome, ${fullName.split(' ')[0]}! 🎉`,'ok');
  initApp();
}

/* ════ AUTH STATE ════ */
onAuthStateChanged(auth,user=>{
  if(user){
    const cur=LS.find(s=>document.getElementById(s)?.classList.contains('active'));
    if(!['ls-google','ls-role','ls-set-pass'].includes(cur))enterApp(user);
  }
});

/* ════ AUTH FLOWS ════ */
document.getElementById('btn-google').addEventListener('click',async()=>{try{await signInWithPopup(auth,new GoogleAuthProvider());lshow('ls-google');}catch(e){toast(fmsg(e.code),'fail');}});
document.getElementById('btn-google-go').addEventListener('click',()=>{if(auth.currentUser)enterApp(auth.currentUser);});
document.getElementById('btn-email-signin').addEventListener('click',async()=>{
  const email=document.getElementById('cred-inp').value.trim(),pass=document.getElementById('pass-inp').value;
  clrErr('err-signin');if(!email){setErr('err-signin','Please enter your email.');return;}if(!pass){setErr('err-signin','Please enter your password.');return;}
  setLd('ld-signin','btn-email-signin',true);
  try{await signInWithEmailAndPassword(auth,email,pass);enterApp(auth.currentUser);}catch(e){setErr('err-signin',fmsg(e.code));}
  finally{setLd('ld-signin','btn-email-signin',false);}
});
document.getElementById('btn-goto-otp').addEventListener('click',()=>{const e=document.getElementById('cred-inp').value.trim();if(e)document.getElementById('otp-email').value=e;lshow('ls-otp-signin');});
document.getElementById('btn-send-otp-link').addEventListener('click',async()=>{
  const email=document.getElementById('otp-email').value.trim();clrErr('err-otp');if(!email){setErr('err-otp','Enter your email.');return;}
  setLd('ld-otp','btn-send-otp-link',true);
  try{await sendSignInLinkToEmail(auth,email,{url:window.location.href,handleCodeInApp:true});localStorage.setItem('emailForSignIn',email);document.getElementById('otp-sent-dest').textContent=email;lshow('ls-otp-sent');toast('Sign-in link sent!','ok');}
  catch(e){setErr('err-otp',fmsg(e.code));}finally{setLd('ld-otp','btn-send-otp-link',false);}
});
document.getElementById('btn-back-otp-sent').addEventListener('click',()=>lshow('ls-land'));
document.getElementById('back-otp').addEventListener('click',()=>lshow('ls-land'));
if(isSignInWithEmailLink(auth,window.location.href)){let email=localStorage.getItem('emailForSignIn')||prompt('Confirm your email:');if(email){signInWithEmailLink(auth,email,window.location.href).then(()=>{localStorage.removeItem('emailForSignIn');history.replaceState({},document.title,location.pathname);enterApp(auth.currentUser);}).catch(e=>toast(fmsg(e.code),'fail'));}}
document.getElementById('btn-forgot-lnk').addEventListener('click',()=>{const e=document.getElementById('cred-inp').value.trim();if(e)document.getElementById('forgot-email').value=e;lshow('ls-forgot');});
document.getElementById('btn-send-reset').addEventListener('click',async()=>{
  const email=document.getElementById('forgot-email').value.trim();clrErr('err-forgot');if(!email){setErr('err-forgot','Enter your email.');return;}
  setLd('ld-forgot','btn-send-reset',true);
  try{await sendPasswordResetEmail(auth,email);document.getElementById('reset-dest').textContent=email;lshow('ls-reset-sent');toast('Reset link sent!','ok');}
  catch(e){setErr('err-forgot',fmsg(e.code));}finally{setLd('ld-forgot','btn-send-reset',false);}
});
document.getElementById('btn-back-reset').addEventListener('click',()=>lshow('ls-land'));
document.getElementById('back-forgot').addEventListener('click',()=>lshow('ls-land'));
let pending={name:'',email:'',tmp:''};
document.getElementById('btn-goto-reg').addEventListener('click',()=>lshow('ls-register'));
document.getElementById('back-reg').addEventListener('click',()=>lshow('ls-land'));
document.getElementById('back-reg-otp').addEventListener('click',()=>lshow('ls-register'));
document.getElementById('btn-send-reg').addEventListener('click',async()=>{
  const name=document.getElementById('reg-name').value.trim(),email=document.getElementById('reg-email').value.trim();clrErr('err-reg');
  if(!name){setErr('err-reg','Enter your name.');return;}if(!email){setErr('err-reg','Enter your email.');return;}
  setLd('ld-reg','btn-send-reg',true);
  try{const tmp='RS!'+Math.random().toString(36).slice(2,10);const c=await createUserWithEmailAndPassword(auth,email,tmp);await updateProfile(c.user,{displayName:name});await sendEmailVerification(c.user);pending={name,email,tmp};document.getElementById('reg-dest').textContent=email;await signOut(auth);lshow('ls-reg-otp');startTimer('t-reg');initOtp('reg-otp-row');toast('Verification email sent!','ok');}
  catch(e){setErr('err-reg',fmsg(e.code));}finally{setLd('ld-reg','btn-send-reg',false);}
});
document.getElementById('btn-verify-reg').addEventListener('click',()=>{const c=getOtp('reg-otp-row');clrErr('err-reg-otp');if(c.length<6){setErr('err-reg-otp','Enter all 6 digits.');return;}lshow('ls-set-pass');toast('Verified! Set your password.','ok');});
document.getElementById('btn-resend-reg').addEventListener('click',async()=>{clrOtp('reg-otp-row');startTimer('t-reg');try{const c=await signInWithEmailAndPassword(auth,pending.email,pending.tmp);await sendEmailVerification(c.user);await signOut(auth);toast('Email resent!','ok');}catch{toast('Could not resend.','fail');}});
document.getElementById('sp1').addEventListener('input',function(){window.chkStr(this.value);});
document.getElementById('btn-set-pass').addEventListener('click',async()=>{
  const p1=document.getElementById('sp1').value,p2=document.getElementById('sp2').value;clrErr('err-set-pass');
  if(p1.length<8){setErr('err-set-pass','Min. 8 characters.');return;}if(p1!==p2){setErr('err-set-pass','Passwords do not match.');return;}
  setLd('ld-set-pass','btn-set-pass',true);
  try{const c=await signInWithEmailAndPassword(auth,pending.email,pending.tmp);const{updatePassword}=await import('https://www.gstatic.com/firebasejs/12.12.0/firebase-auth.js');await updatePassword(c.user,p1);lshow('ls-role');}
  catch(e){setErr('err-set-pass',fmsg(e.code));}finally{setLd('ld-set-pass','btn-set-pass',false);}
});
document.getElementById('btn-skip-pass').addEventListener('click',()=>lshow('ls-role'));
document.getElementById('btn-role-go').addEventListener('click',()=>{if(auth.currentUser)enterApp(auth.currentUser);});
window.doSignOut=async()=>{clearLiveWatchers();ownerListings=[];riderBookings=[];ownerBookings=[];withdrawalRequests=[];damageReports=[];damageBikeChoices=[];selectedListingId=null;await signOut(auth);document.getElementById('page-app').style.display='none';document.getElementById('page-login').style.display='flex';lshow('ls-land');toast('Signed out.');};

/* ════ APP INIT ════ */
async function initApp(){
  clearLiveWatchers();
  await ensureBackendBootstrap();
  initMap();
  loadUserRealtime();
  loadBikesRealtime();
  loadBookingsRealtime();
  loadOwnerDataRealtime();
  locateUser();
}

/* ════ MAP ════ */
function initMap(){
  if(leafMap)return;
  leafMap=L.map('map',{zoomControl:true,attributionControl:false}).setView([12.8970,80.0040],15);
  L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png',{maxZoom:19}).addTo(leafMap);
  setTimeout(()=>leafMap.invalidateSize(),200);
}

window.locateUser=function(){
  if(!navigator.geolocation){document.getElementById('location-txt').textContent='Chennai';return;}
  navigator.geolocation.getCurrentPosition(pos=>{
    const{latitude:lat,longitude:lng}=pos.coords;
    if(leafMap)leafMap.setView([lat,lng],15);
    if(userMarker)leafMap.removeLayer(userMarker);
    userMarker=L.circleMarker([lat,lng],{radius:9,fillColor:'#1565C0',color:'#fff',weight:3,fillOpacity:1}).addTo(leafMap).bindPopup('<strong>📍 You are here</strong>').openPopup();
    /* Reverse geocode */
    fetch(`https://nominatim.openstreetmap.org/reverse?lat=${lat}&lon=${lng}&format=json`).then(r=>r.json()).then(d=>{const area=d.address?.suburb||d.address?.neighbourhood||d.address?.town||d.address?.city||'Your location';document.getElementById('location-txt').textContent=area;document.getElementById('view-sub').textContent=`${area} · ${bikeMarkers?Object.keys(bikeMarkers).length:0} bikes nearby`;}).catch(()=>{document.getElementById('location-txt').textContent='Chennai';});
  },()=>{document.getElementById('location-txt').textContent='Chennai';if(leafMap)leafMap.setView([12.8970,80.0040],15);});
};

/* ════ FIRESTORE: BIKES ════ */
let bikeData=BIKES_SEED.map(b=>({...b,rating:4.0+Math.random()*0.9,reviewCount:Math.floor(Math.random()*30)+3}));
function loadBikesRealtime(){
  trackSnapshot(collection(db,'bikes'),snap=>{
    bikeData=snap.empty
      ? BIKES_SEED.map(b=>({...b,rating:b.rating||4.0+Math.random()*0.9,reviewCount:b.reviewCount||Math.floor(Math.random()*30)+3}))
      : snap.docs.map(d=>({...d.data(),id:d.id})).filter(b=>!b.archived&&b.active!==false);
    renderBikeList(curFilter);
    renderBikeMarkers();
    updateStats();
  });
}

function getBikeIcon(b){
  const clr=b.avail?'#22c55e':'#ef4444';
  return L.divIcon({html:`<div style="background:${b.color||'#E3F2FD'};width:38px;height:28px;border-radius:8px;border:2.5px solid ${b.stroke||'#1565C0'};display:flex;align-items:center;justify-content:center;box-shadow:0 2px 8px rgba(0,0,0,.2);"><svg width="24" height="16" viewBox="0 0 100 60" fill="none"><ellipse cx="18" cy="46" rx="13" ry="13" stroke="${b.stroke||'#1565C0'}" stroke-width="4"/><ellipse cx="82" cy="46" rx="13" ry="13" stroke="${b.stroke||'#1565C0'}" stroke-width="4"/><path d="M18 46L36 18h28l18 28" stroke="${b.stroke||'#1565C0'}" stroke-width="4"/></svg></div><div style="width:8px;height:8px;border-radius:50%;background:${clr};border:2px solid #fff;margin:-4px auto 0;"></div>`,className:'',iconSize:[38,38],iconAnchor:[19,38]});
}

function renderBikeMarkers(){
  if(!leafMap)return;
  Object.values(bikeMarkers).forEach(m=>leafMap.removeLayer(m));
  bikeMarkers={};
  bikeData.forEach(b=>{
    if(!b.lat||!b.lng)return;
    const stars='★'.repeat(Math.round(b.rating||4))+'☆'.repeat(5-Math.round(b.rating||4));
    const m=L.marker([b.lat,b.lng],{icon:getBikeIcon(b)}).addTo(leafMap);
    m.bindPopup(`<div class="bike-popup"><strong>${b.name}</strong>Owner: ${b.owner}<br/><span class="popup-price">₹${b.price}/hr</span> &nbsp; ${stars} ${(b.rating||4).toFixed(1)} (${b.reviewCount||0})<br/>${b.avail?'<span style="color:#166534;font-weight:700;">● Available</span>':'<span style="color:#991b1b;font-weight:700;">● Busy</span>'}<br/><button class="popup-select-btn" onclick="selectBike('${b.id}')">Select &amp; book</button></div>`,{maxWidth:200});
    bikeMarkers[b.id]=m;
  });
}

function updateStats(){
  const avail=bikeData.filter(b=>b.avail);
  document.getElementById('stat-avail').textContent=avail.length;
  if(avail.length){document.getElementById('stat-avg').textContent='₹'+Math.round(avail.reduce((s,b)=>s+b.price,0)/avail.length);}
  const allRatings=bikeData.filter(b=>b.rating);
  if(allRatings.length){document.getElementById('stat-rating').textContent=(allRatings.reduce((s,b)=>s+b.rating,0)/allRatings.length).toFixed(1)+'★';}
  const total=bikeData.reduce((s,b)=>s+(b.reviewCount||0),0);
  document.getElementById('stat-rides').textContent=total;
  document.getElementById('bc-count').textContent=`${avail.length} available`;
}

/* ════ BIKE LIST ════ */
window.filterBikes=function(q){curSearch=q;renderBikeList(curFilter);};
window.setFilter=function(f,el){curFilter=f;document.querySelectorAll('.fchip').forEach(c=>c.classList.remove('on'));el.classList.add('on');renderBikeList(f);};

function renderBikeList(filter){
  let list=bikeData.filter(b=>{
    if(curSearch&&!b.name?.toLowerCase().includes(curSearch.toLowerCase())&&!b.owner?.toLowerCase().includes(curSearch.toLowerCase()))return false;
    if(filter==='available')return b.avail;
    if(filter==='cheap')return b.price<30;
    if(filter==='top')return(b.rating||0)>=4.5;
    return true;
  });
  const g=document.getElementById('bike-list-inner');
  if(!g)return;
  if(!list.length){g.innerHTML='<div style="padding:20px;text-align:center;color:var(--txt2);font-size:12px;">No bikes match your filter</div>';return;}
  g.innerHTML=list.map(b=>{
    const stars=renderStars(b.rating||4.0,10);
    return`<div class="bcard${selBike?.id===b.id?' sel':''}" onclick="selectBike('${b.id}')"><div class="bcard-img" style="background:${b.color||'#E3F2FD'};">${bikeSVG(b.stroke||'#1565C0',40,28)}</div><div class="bcard-info"><div class="bc-name">${b.name}</div><div class="bc-owner">${b.owner} · ${b.dist}km</div><div class="bc-footer"><div class="bc-price">₹${b.price}/hr</div><div class="bc-stars">${stars}<span class="bc-rat"> ${(b.rating||4.0).toFixed(1)} (${b.reviewCount||0})</span></div></div><div class="bc-badge ${b.avail?'free':'busy'}">${b.avail?'Available':'Busy'}</div></div></div>`;
  }).join('');
}

function bikeSVG(stroke,w,h){return`<svg width="${w}" height="${h}" viewBox="0 0 100 60" fill="none"><ellipse cx="18" cy="46" rx="13" ry="13" stroke="${stroke}" stroke-width="3"/><ellipse cx="82" cy="46" rx="13" ry="13" stroke="${stroke}" stroke-width="3"/><path d="M18 46L36 18h28l18 28" stroke="${stroke}" stroke-width="3"/><path d="M36 18L32 46M60 18l6-10h16" stroke="${stroke}" stroke-width="2.5" stroke-linecap="round"/></svg>`;}
function renderStars(rating,sz=11){const full=Math.floor(rating),empty=5-full;return`${'<span class="bc-star" style="font-size:'+sz+'px;">★</span>'.repeat(full)}${'<span class="bc-star" style="font-size:'+sz+'px;color:var(--bdr2);">☆</span>'.repeat(empty)}`;}

/* ════ SELECT BIKE ════ */
window.selectBike=async function(id){
  selBike=bikeData.find(b=>b.id===id);if(!selBike)return;
  selSlot=selBike.slots?.findIndex(s=>!s.taken)??0;if(selSlot<0)selSlot=0;
  renderBikeList(curFilter);
  
  /* Fly map to bike */
  if(leafMap&&selBike.lat&&selBike.lng){leafMap.flyTo([selBike.lat,selBike.lng],16,{duration:1});bikeMarkers[id]?.openPopup();}

  /* Load real-time reviews from Firestore */
  let reviews=[];
  try{const qs=await getDocs(query(collection(db,'bikes',id,'reviews'),orderBy('createdAt','desc')));reviews=qs.docs.map(d=>d.data());}catch(e){}
  
  const avgRating=reviews.length?reviews.reduce((s,r)=>s+(r.rating||0),0)/reviews.length:(selBike.rating||4.0);
  const revCount=reviews.length||(selBike.reviewCount||0);
  const lastReview=reviews[0];

  const conds=(selBike.conds||[]).map(c=>`<span class="ctag">${c}</span>`).join('');
  const warns=(selBike.warn||[]).map(w=>`<span class="ctag warn">${w}</span>`).join('');
  const price=selBike.price;
  const fee=(price*0.08).toFixed(2);
  const total=(price+parseFloat(fee)).toFixed(2);
  selSlot=selBike.slots?.findIndex(s=>!s.taken)??0;
  
  document.getElementById('bp-title').textContent=selBike.name;
  document.getElementById('bp-sub').textContent=`${selBike.owner} · Verified · ${selBike.dist}km away`;
  
  document.getElementById('bpb-content').innerHTML=`
    <div><div class="psec">Real-time rating</div>
      <div class="rt-stars">${[1,2,3,4,5].map(i=>`<span class="rt-star${i<=Math.round(avgRating)?' on':''}">★</span>`).join('')}<span class="rt-avg">${avgRating.toFixed(1)}</span><span class="rt-count"> (${revCount} reviews)</span></div>
      ${lastReview?`<div class="review-txt">"${lastReview.text||'Good ride.'}" — ${lastReview.renterName||'Renter'}, ${lastReview.date||'recently'}</div>`:''}
    </div>
    <div><div class="psec">Bike condition</div><div class="ctagrow">${conds}${warns}</div></div>
    <div><div class="psec">Location on map</div><div style="font-size:11px;color:var(--txt2);">📍 ${selBike.dist}km from you · See pin on map</div></div>
    <div><div class="psec">Pick a time slot</div><div class="slotgrid">${(selBike.slots||[]).map((s,i)=>`<div class="slot${s.taken?' taken':i===selSlot?' on':''}" onclick="${s.taken?'':'appSelSlot('+i+')'}">${s.t}</div>`).join('')}</div></div>
    <div><div class="psec">Pay with</div>
      <div style="display:flex;flex-direction:column;gap:5px;">
        <div class="payopt on" onclick="selPay(this)"><div class="payic" style="background:#E3F2FD;color:#1565C0;">G</div><span class="paylbl">Google Pay (GPay)</span></div>
        <div class="payopt" onclick="selPay(this)"><div class="payic" style="background:var(--green-s);color:#166534;">CC</div><span class="paylbl">Credit / Debit card</span></div>
        <div class="payopt" onclick="selPay(this)"><div class="payic" style="background:var(--warn-s);color:#7B5800;">₹</div><span class="paylbl">Cash on pickup</span></div>
      </div>
    </div>
    <div>
      <div class="psec">Summary</div>
      <div class="sumrow"><span>₹${price} × 1 hour</span><span>₹${price}.00</span></div>
      <div class="sumrow"><span>Platform fee (8%)</span><span>₹${fee}</span></div>
      <div class="sumrow tot"><span>Total</span><span>₹${total}</span></div>
    </div>
    ${selBike.avail?`<button class="bookbtn" onclick="confirmBooking()">Confirm booking · ₹${total}</button>`:'<div style="text-align:center;padding:10px;font-size:12px;color:var(--err);font-weight:600;">⚠ This bike is not available right now</div>'}
    <div style="font-size:10px;color:var(--txt3);text-align:center;">Secured by Razorpay · 8% platform fee applied</div>
  `;
};

window.appSelSlot=function(i){selSlot=i;selectBike(selBike.id);};
window.selPay=function(el){document.querySelectorAll('.payopt').forEach(p=>p.classList.remove('on'));el.classList.add('on');};

/* ════ BOOKING ════ */
window.confirmBooking=async function(){
  if(!selBike||!currentUser){toast('Please sign in first','fail');return;}
  if(!selBike.avail){toast('Bike not available','fail');return;}
  const slot=selBike.slots[selSlot]?.t;
  if(!slot){toast('Please choose a valid slot','fail');return;}
  try{
    const{data:orderData}=await createBookingOrderFn({bikeId:selBike.id,slot});
    if(typeof Razorpay!=='function')throw new Error('Razorpay checkout is not available.');
    const rzp=new Razorpay({
      key:orderData.keyId,
      order_id:orderData.orderId,
      amount:orderData.amount,
      currency:orderData.currency,
      name:'RideShare',
      description:`Rent ${selBike.name} — 1 hour`,
      prefill:{email:currentUser.email,name:currentUser.displayName||''},
      theme:{color:'#1565C0'},
      handler:async function(resp){
        await verifyBookingPaymentFn({bookingId:orderData.bookingId,orderId:resp.razorpay_order_id,paymentId:resp.razorpay_payment_id,signature:resp.razorpay_signature});
        showBookingSuccess(orderData.bookingId,Number(orderData.total));
      }
    });
    rzp.on('payment.failed',()=>toast('Payment failed. Please try again.','fail'));
    rzp.open();
  }catch(e){toast(e?.message||'Unable to start booking payment.','fail');}
};

/* ════ RATING SYSTEM ════ */
window.openRatingModal=function(bikeName,owner){selStar=4;document.getElementById('rate-bike-name').textContent=bikeName;setStars(4);openModal('modal-rating');};
window.setStars=function(n){selStar=n;document.querySelectorAll('.mstar').forEach((s,i)=>s.className='mstar'+(i<n?' lit':''));};
window.toggleCondTag=function(el){el.classList.toggle('warn');};
window.submitRating=async function(){
  const text=document.getElementById('review-text').value.trim();
  const reviewData={rating:selStar,text:text||'Good ride.',renterName:currentUser?.displayName||'Anonymous',date:new Date().toLocaleDateString('en-IN',{day:'numeric',month:'short'}),userId:currentUser?.uid,createdAt:serverTimestamp()};
  try{
    const targetId=selBike?.id||'bike1';
    await addDoc(collection(db,'bikes',targetId,'reviews'),reviewData);
    const qs=await getDocs(collection(db,'bikes',targetId,'reviews'));
    const reviews=qs.docs.map(d=>d.data());
    const avgRating=reviews.reduce((s,r)=>s+(r.rating||0),0)/reviews.length;
    bikeData=bikeData.map(b=>b.id===targetId?{...b,rating:parseFloat(avgRating.toFixed(1)),reviewCount:reviews.length}:b);
    renderBikeList(curFilter);
    renderBikeMarkers();
    updateStats();
    toast('Rating submitted! ⭐','ok');
  }catch(e){toast('Rating saved locally','ok');}
  closeModal('modal-rating');
};

/* ════ NAV ════ */
const VIEW_TITLES={browse:'Browse bikes',bookings:'My bookings',kyc:'KYC & Safety',damage:'Damage report',listings:'My listings',earnings:'Earnings'};
const VIEW_SUBS={browse:'Real-time map of nearby bikes',bookings:'Manage your active and past rides',kyc:'Identity verification & safety settings',damage:'Report &amp; resolve vehicle damage',listings:'Manage your listed bikes &amp; schedules',earnings:'Your earnings &amp; Razorpay transactions'};
const FILTER_VIEWS=['browse'];
window.navTo=function(v){
  ['browse','bookings','kyc','damage','listings','earnings'].forEach(x=>{const el=document.getElementById('view-'+x);if(el)el.className='view'+(x===v?' active':'');});
  document.querySelectorAll('.nav-item').forEach(n=>n.classList.remove('on'));
  const ni=document.getElementById('nav-'+v);if(ni)ni.classList.add('on');
  document.getElementById('view-title').textContent=VIEW_TITLES[v]||v;
  document.getElementById('view-sub').innerHTML=VIEW_SUBS[v]||'';
  document.getElementById('filter-row').style.display=FILTER_VIEWS.includes(v)?'flex':'none';
  if(v==='browse'){setTimeout(()=>leafMap?.invalidateSize(),100);}
};
window.switchRole=function(r){
  document.getElementById('role-rent').className='rbtn'+(r==='rent'?' on':'');
  document.getElementById('role-list').className='rbtn'+(r==='list'?' on':'');
  navTo(r==='list'?'listings':'browse');
};

/* ════ MODALS ════ */
window.openModal=id=>{document.getElementById(id)?.classList.add('show');};
window.closeModal=id=>{document.getElementById(id)?.classList.remove('show');};
document.querySelectorAll('.modal-overlay').forEach(o=>o.addEventListener('click',e=>{if(e.target===o)o.classList.remove('show');}));
window.toggleAvatarMenu=function(){document.getElementById('avatar-menu').classList.toggle('show');};
window.closeAvatarMenu=function(){document.getElementById('avatar-menu').classList.remove('show');};
document.addEventListener('click',e=>{const m=document.getElementById('avatar-menu');if(m&&!e.target.closest('.tavatar'))m.classList.remove('show');});

/* ════ PROFILE ════ */
window.saveProfile=async function(){
  const name=document.getElementById('prof-name').value.trim();
  const display=document.getElementById('prof-display').value.trim()||name;
  const phone=document.getElementById('prof-phone').value.trim();
  const city=document.getElementById('prof-city').value.trim();
  if(!name){toast('Please enter your name','fail');return;}
  try{
    await updateProfile(auth.currentUser,{displayName:display});
    await setDoc(doc(db,'users',currentUser.uid),{fullName:name,displayName:display,phone,city,photoURL:currentProfileUrl},{merge:true});
    document.getElementById('sf-name').textContent=name;
    document.getElementById('amh-name').textContent=name;
    toast('Profile updated! ✓','ok');closeModal('modal-profile');
  }catch(e){toast('Update failed','fail');}
};

window.uploadProfilePic=async function(input){
  if(!input.files[0])return;
  const file=input.files[0];
  if(file.size>5*1024*1024){toast('File too large (max 5MB)','fail');return;}
  toast('Uploading photo...','info');
  try{
    const storageRef=ref(storage,`profiles/${currentUser.uid}/photo_${Date.now()}`);
    await uploadBytes(storageRef,file);
    const url=await getDownloadURL(storageRef);
    currentProfileUrl=url;
    await updateProfile(auth.currentUser,{photoURL:url});
    await setDoc(doc(db,'users',currentUser.uid),{photoURL:url},{merge:true});
    /* Update all avatars */
    const img=`<img src="${url}" style="width:100%;height:100%;object-fit:cover;border-radius:50%;"/>`;
    document.getElementById('sf-avatar').innerHTML=img;
    document.getElementById('user-avatar').innerHTML=img+'<div class="avatar-menu" id="avatar-menu">'+document.getElementById('avatar-menu').innerHTML+'</div>';
    document.getElementById('ppc-initials').outerHTML=`<img src="${url}" id="ppc-initials" style="width:100%;height:100%;object-fit:cover;border-radius:50%;"/>`;
    toast('Profile photo updated! ✓','ok');
  }catch(e){toast('Upload failed — check Firebase Storage rules','fail');}
};

/* ════ KYC ════ */
window.handleKycUpload=async function(input,type){
  if(!input.files[0])return;
  const file=input.files[0];
  if(file.size>5*1024*1024){toast('File too large (max 5MB)','fail');return;}
  if(!currentUser){toast('Please sign in first','fail');return;}
  toast(`Uploading ${type} document...`,'info');
  const statusEl=document.getElementById(`kyc-${type}-status`);
  try{
    await uploadPrivateFile(file,'kyc',type);
    if(statusEl){statusEl.className='kyc-status pend';statusEl.textContent='⏳ Under verification';}
    toast(`${type} uploaded! Under manual review (24–48 hrs).`,'ok');
  }catch(e){toast(e?.message||'Upload failed. Please try again.','fail');}
};

window.saveEmergencyContact=async function(){
  const name=document.getElementById('ec-name').value.trim();
  const phone=document.getElementById('ec-phone').value.trim();
  const email=document.getElementById('ec-email').value.trim();
  const relationship=document.getElementById('ec-relationship').value;
  if(!name||!phone){toast('Please enter name and phone','fail');return;}
  try{
    await setDoc(doc(db,'users',currentUser.uid),{emergencyContact:{name,phone,email,relationship}},{merge:true});
    toast('Emergency contact saved! ✓','ok');
  }catch(e){toast('Saved locally','ok');}
};

window.saveToggle=async function(key,val){
  try{await setDoc(doc(db,'users',currentUser.uid),{settings:{[key]:val}},{merge:true});}catch(e){}
  toast(`${key.replace('_',' ')} ${val?'enabled':'disabled'}`,'info');
};

/* ════ DAMAGE REPORT ════ */
window.setSev=function(sev){
  dmgSeverity=sev;
  ['minor','moderate','severe'].forEach(s=>{const el=document.getElementById('sev-'+s);if(el)el.className='sev-opt'+(s===sev?sev==='minor'?' on':sev==='moderate'?' won':' eon':'');});
};

function renderDamageAssessmentStep(report){
  const estimate=getDamageEstimate(report.severity||dmgSeverity);
  document.getElementById('dp-2').innerHTML=`<div class="info-panel" style="margin-bottom:14px;"><strong>⚠ Damage assessment submitted</strong><br/>Your report for <strong>${report.bikeLabel||'the selected bike'}</strong> has been sent to the bike owner and our team. You can continue to payment once you review the estimate below.</div><div class="card-box"><div class="section-head">Estimated costs</div><div class="sumrow"><span>${estimate.label}</span><span>${formatCurrency(estimate.repair)}</span></div><div class="sumrow"><span>Service centre handling</span><span>${formatCurrency(estimate.service)}</span></div><div class="sumrow tot"><span>Your estimated liability</span><span>${formatCurrency(estimate.repair+estimate.service)}</span></div></div><button class="lbtnblue" onclick="dmgStep(3)">Proceed to payment →</button>`;
  document.getElementById('dp-3').innerHTML=`<div class="card-box" style="margin-bottom:14px;"><div class="sumrow"><span>Repair cost</span><span>${formatCurrency(estimate.repair)}</span></div><div class="sumrow"><span>Service centre fee</span><span>${formatCurrency(estimate.service)}</span></div><div class="sumrow tot"><span>Total due</span><span>${formatCurrency(estimate.repair+estimate.service)}</span></div></div><button class="lbtnblue" onclick="payDamage(${estimate.repair+estimate.service})">Pay ${formatCurrency(estimate.repair+estimate.service)} via Razorpay →</button><div style="font-size:11px;color:var(--txt2);text-align:center;margin-top:10px;">Secured by Razorpay · GPay, card, UPI accepted</div>`;
  document.getElementById('dp-4').innerHTML=`<div class="success-panel" style="margin-bottom:14px;">✅ Payment received! The service request for <strong>${report.bikeLabel||'your bike'}</strong> is now active.</div><div class="card-box"><div style="font-size:13px;font-weight:700;color:var(--txt);margin-bottom:4px;">RideShare partner service desk</div><div style="font-size:12px;color:var(--txt2);line-height:1.7;">We have recorded your claim and notified the owner. Our service team will contact you using your registered phone number with the next inspection slot.<br/>📌 Reference: <strong>${report.id||latestDamageReportId||''}</strong></div><button class="lbtnblue" style="margin-top:12px;font-size:12px;" onclick="navTo('bookings')">Back to bookings →</button></div><div style="font-size:11px;color:var(--txt2);margin-top:10px;text-align:center;">The damaged bike remains blocked for new rentals until the report is resolved.</div>`;
}

window.handleDmgPhotos=function(input){
  const files=[...input.files];dmgPhotos=files;
  const prev=document.getElementById('dmg-preview');
  prev.innerHTML=files.map(f=>{const url=URL.createObjectURL(f);return`<img class="photo-thumb" src="${url}"/>`;}).join('');
  toast(`${files.length} photo(s) selected`,'info');
};

window.submitDamageReport=async function(){
  const bikeId=document.getElementById('dmg-bike-sel').value;
  const desc=document.getElementById('dmg-description').value.trim();
  if(!bikeId){toast('Please select the bike','fail');return;}
  if(dmgPhotos.length<2){toast('Please upload at least 2 photos','fail');return;}
  if(!desc){toast('Please describe what happened','fail');return;}
  if(!currentUser){toast('Please sign in first','fail');return;}
  toast('Submitting damage report...','info');
  try{
    const bikeChoice=damageBikeChoices.find(choice=>choice.id===bikeId)||{};
    const estimate=getDamageEstimate(dmgSeverity);
    const attachments=[];
    for(const f of dmgPhotos.slice(0,5)){
      attachments.push(await uploadPrivateFile(f,'damage','damage_photo'));
    }
    const reportRef=await addDoc(collection(db,'damage_reports'),{userId:currentUser.uid,userEmail:currentUser.email,userName:currentUser.displayName,bikeId,bikeLabel:bikeChoice.label||bikeId,ownerUid:bikeChoice.ownerUid||null,severity:dmgSeverity,description:desc,type:document.getElementById('dmg-type-sel').value,date:document.getElementById('dmg-date').value,time:document.getElementById('dmg-time').value,attachments,estimatedRepair:estimate.repair,serviceFee:estimate.service,estimatedAmount:estimate.repair+estimate.service,status:'submitted',createdAt:serverTimestamp()});
    latestDamageReportId=reportRef.id;
    renderDamageAssessmentStep({id:reportRef.id,bikeLabel:bikeChoice.label||bikeId,severity:dmgSeverity});
    toast('Report submitted! Email sent to your inbox.','ok');
    dmgStep(2);
  }catch(e){toast(e?.message||'Unable to submit the damage report.','fail');}
};

window.dmgStep=function(n){
  dmgCurStep=n;
  [1,2,3,4].forEach(i=>{const s=document.getElementById('ds'+i);if(s)s.className='dmg-step'+(i<n?' done':i===n?' active':'');const p=document.getElementById('dp-'+i);if(p)p.style.display=i===n?'block':'none';});
};
window.payDamage=function(amt){
  if(!latestDamageReportId){toast('Please submit the damage report first','fail');return;}
  createDamagePaymentOrderFn({reportId:latestDamageReportId,amount:amt}).then(({data})=>{
    if(typeof Razorpay!=='function')throw new Error('Razorpay checkout is not available.');
    const rzp=new Razorpay({
      key:data.keyId,
      order_id:data.orderId,
      amount:data.amount,
      currency:data.currency,
      name:'RideShare Damage',
      description:'Vehicle damage payment',
      theme:{color:'#1565C0'},
      handler:async(resp)=>{
        await verifyDamagePaymentFn({reportId:latestDamageReportId,orderId:resp.razorpay_order_id,paymentId:resp.razorpay_payment_id,signature:resp.razorpay_signature});
        toast('Payment received!','ok');dmgStep(4);
      }
    });
    rzp.on('payment.failed',()=>toast('Damage payment failed. Please try again.','fail'));
    rzp.open();
  }).catch((e)=>toast(e?.message||'Unable to start damage payment.','fail'));
};

/* ════ LISTINGS ════ */
window.selectListing=function(id){selectedListingId=id;renderListings();};
window.toggleListing=async function(id,active){
  const listing=ownerListings.find(item=>item.id===id);
  try{
    await apiRequest(`/listings/${id}/toggle`,{method:'PATCH',body:{active}});
    toast(`${listing?.name||'Listing'} ${active?'listed':'unlisted'}`,'ok');
  }catch(e){toast(e?.message||'Unable to update the listing state.','fail');renderListings();}
};
window.toggleDay=function(btn){btn.classList.toggle('on');};
window.saveSchedule=async function(){
  if(!selectedListingId){toast('Please select a listing first.','info');return;}
  const days=[...document.querySelectorAll('#day-grid .day-btn.on')].map(btn=>btn.textContent.trim());
  const from=document.getElementById('avail-from').value;
  const to=document.getElementById('avail-to').value;
  const minimumDuration=document.getElementById('min-duration-select').value;
  const price=Number(document.getElementById('schedule-price-input').value);
  try{
    await apiRequest(`/listings/${selectedListingId}`,{method:'PATCH',body:{price,schedule:{days,from,to,minimumDuration}}});
    toast('Schedule saved!','ok');
  }catch(e){toast(e?.message||'Unable to save the schedule.','fail');}
};
window.deleteListing=async function(id){
  const listing=ownerListings.find(item=>item.id===id);
  if(!listing)return;
  try{
    await apiRequest(`/listings/${id}`,{method:'DELETE'});
    toast(`${listing.name} removed from listings`,'info');
  }catch(e){toast(e?.message||'Unable to remove the listing.','fail');}
};
window.openEditListing=function(id){
  const listing=ownerListings.find(item=>item.id===id);
  if(!listing)return;
  selectedListingId=id;
  document.getElementById('edit-listing-name').textContent=listing.name;
  document.getElementById('edit-price').value=listing.price||'';
  document.getElementById('edit-desc').value=listing.conditionNotes||'';
  openModal('modal-edit-listing');
};
window.saveListingEdit=async function(){
  if(!selectedListingId){toast('Please select a listing first.','info');return;}
  const price=Number(document.getElementById('edit-price').value);
  const conditionNotes=document.getElementById('edit-desc').value.trim();
  try{
    await apiRequest(`/listings/${selectedListingId}`,{method:'PATCH',body:{price,conditionNotes}});
    toast('Listing updated!','ok');
    closeModal('modal-edit-listing');
  }catch(e){toast(e?.message||'Unable to update the listing.','fail');}
};
window.addBikeListing=async function(){
  const type=document.getElementById('new-bike-type').value;
  const price=Number(document.getElementById('new-bike-price').value);
  const registrationNumber=document.getElementById('new-bike-reg').value.trim();
  if(!price){toast('Please enter a price','fail');return;}
  if(!registrationNumber){toast('Please enter the registration number','fail');return;}
  try{
    await apiRequest('/listings',{method:'POST',body:{name:type,registrationNumber,price,conditionNotes:document.getElementById('new-bike-cond').value.trim(),schedule:{days:['Mon','Tue','Wed','Thu','Fri'],from:document.getElementById('new-from').value,to:document.getElementById('new-to').value,minimumDuration:'1 hour'}}});
    toast(`${type} submitted successfully!`,'ok');
    document.getElementById('new-bike-reg').value='';
    document.getElementById('new-bike-price').value='';
    document.getElementById('new-bike-cond').value='';
    closeModal('modal-add-bike');
  }catch(e){toast(e?.message||'Unable to create the listing.','fail');}
};

/* ════ EARNINGS / RAZORPAY ════ */
window.initiateWithdrawal=async function(){
  const pending=parseFloat((document.getElementById('earn-pending').textContent||'0').replace(/[^\d.]/g,''));
  if(!pending){toast('No pending balance available to withdraw.','info');return;}
  try{
    await requestWithdrawalFn({amount:pending});
    document.getElementById('earn-pending').textContent='₹0.00';
    toast('Withdrawal request submitted. It will be processed in 2–3 business days.','ok');
  }catch(e){toast(e?.message||'Unable to request a withdrawal.','fail');}
};
window.saveBankDetails=async function(){
  const name=document.getElementById('bank-name').value.trim();
  const acc=document.getElementById('bank-acc').value.trim();
  const ifsc=document.getElementById('bank-ifsc').value.trim();
  if(!name||!ifsc){toast('Please fill required fields','fail');return;}
  try{
    await saveBankAccountFn({holderName:name,accountNumber:acc,ifsc,bankName:document.getElementById('bank-bank').value.trim(),upi:document.getElementById('bank-upi').value.trim()});
    toast('Bank details saved securely! ✓','ok');closeModal('modal-payment-setup');
  }catch(e){toast(e?.message||'Unable to save bank details.','fail');}
};

/* ════ BOOKINGS ACTIONS ════ */
window.cancelBooking=()=>{toast('Booking cancelled. Refund in 3–5 days.','ok');closeModal('modal-cancel');};
window.confirmExtend=()=>{const hrs=document.getElementById('extend-sel').value;toast(`Ride extended by ${hrs==='0.5'?'30 min':''+parseFloat(hrs)+' hr'}!`,'ok');closeModal('modal-extend');};
window.contactOwner=name=>{toast(`Calling ${name}...`,'info');};

/* ════ MISC ════ */
window.openRatingModal=function(bike,owner){selStar=4;document.getElementById('rate-bike-name').textContent=bike;setStars(4);document.getElementById('review-text').value='';openModal('modal-rating');};
setSev('minor');
document.getElementById('dmg-date').valueAsDate=new Date();
document.getElementById('dmg-time').value=new Date().toTimeString().slice(0,5);
