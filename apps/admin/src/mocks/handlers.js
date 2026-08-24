import { http, HttpResponse } from 'msw';

export const handlers = [
  // Authentication
  http.post('*/api/admin/login', async ({ request }) => {
    const body = await request.json();
    if (body.password === 'correct_password') {
      return HttpResponse.json({ data: { token: 'fake_token' } });
    }
    return HttpResponse.json({ message: 'Invalid credentials' }, { status: 401 });
  }),

  // Users
  http.get('*/api/admin/users', () => {
    return HttpResponse.json({
      data: [{ _id: '1', phoneNumber: '+1234567890', createdAt: new Date().toISOString() }],
      pagination: { total: 1, page: 1, limit: 50 },
    });
  }),

  // Transactions
  http.get('*/api/admin/transactions', ({ request }) => {
    const url = new URL(request.url);
    const page = url.searchParams.get('page');
    
    if (page === '99') {
       return HttpResponse.json({ message: 'Server error' }, { status: 500 });
    }

    if (page === '2') {
      return HttpResponse.json({
        data: [],
        pagination: { total: 0, page: 2, limit: 50 },
      });
    }

    return HttpResponse.json({
      data: [{ _id: 'tx1', type: 'deposit', amount: '100', asset: 'USDC', status: 'Completed', createdAt: new Date().toISOString() }],
      pagination: { total: 1, page: 1, limit: 50 },
    });
  }),

  // KYC
  http.get('*/api/admin/kyc', () => {
    return HttpResponse.json({
      data: [{ _id: 'kyc1', userId: { phoneNumber: '+1234567890' }, provider: 'Onfido', tier: 'Tier 1', riskScore: 'Low', status: 'Pending', updatedAt: new Date().toISOString() }]
    });
  }),
  
  http.post('*/api/compliance/kyc/:id/review', () => {
    return HttpResponse.json({ success: true });
  }),
];
