// auth-check.js - Include this at the top of every protected page
(function() {
  // The same password from auth.html (must match!)
  const CORRECT_PASSWORD = 'DEMO2024';  // ← Change this to match auth.html
  
  // Check if on auth page (don't redirect from auth page)
  if (window.location.pathname.includes('auth.html')) {
    return;
  }
  
  // Check authentication
  const authToken = sessionStorage.getItem('auth_token');
  
  if (!authToken || authToken !== btoa(CORRECT_PASSWORD)) {
    // Not authenticated - redirect to auth page
    window.location.href = 'auth.html';
  }
})();