import { useEffect, useState } from 'react';
import { getAdminKyc, approveKyc, rejectKyc } from '@/lib/adminApi';
import DataTable from '@/components/DataTable';
import StatusBadge from '@/components/StatusBadge';
import Loader from '@shared/Loader';

export default function KycReview() {
  const [rows, setRows] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [mutatingId, setMutatingId] = useState(null);

  useEffect(() => {
    let active = true;
    getAdminKyc()
      .then((res) => {
        if (active) setRows(res.data || []);
      })
      .catch((err) => {
        if (active) setError(err.message || 'Failed to fetch KYC profiles');
      })
      .finally(() => {
        if (active) setLoading(false);
      });
    return () => {
      active = false;
    };
  }, []);

  const handleApprove = async (id) => {
    setMutatingId(id);
    setError('');
    try {
      await approveKyc(id);
      setRows((prev) => prev.map((r) => r._id === id ? { ...r, status: 'Approved' } : r));
    } catch (err) {
      setError(err.response?.data?.message || 'Failed to approve KYC');
    } finally {
      setMutatingId(null);
    }
  };

  const handleReject = async (id) => {
    setMutatingId(id);
    setError('');
    try {
      await rejectKyc(id);
      setRows((prev) => prev.map((r) => r._id === id ? { ...r, status: 'Rejected' } : r));
    } catch (err) {
      setError(err.response?.data?.message || 'Failed to reject KYC');
    } finally {
      setMutatingId(null);
    }
  };

  if (loading) return <div className="flex justify-center py-20" data-testid="kyc-loading"><Loader size={32} /></div>;

  const columns = [
    { header: 'User', render: (row) => row.userId?.phoneNumber || '-' },
    { header: 'Provider', accessor: 'provider' },
    { header: 'Tier', accessor: 'tier' },
    { header: 'Risk', accessor: 'riskScore' },
    { header: 'Status', render: (row) => <StatusBadge status={row.status} /> },
    { header: 'Updated', render: (row) => new Date(row.updatedAt).toLocaleString() },
    { header: 'Actions', render: (row) => (
      row.status === 'Pending' && (
        <div className="flex gap-2">
          <button 
            onClick={() => handleApprove(row._id)}
            disabled={mutatingId === row._id}
            className="px-3 py-1 text-xs bg-green-600 text-white rounded hover:bg-green-700 disabled:opacity-50"
          >
            Approve
          </button>
          <button 
            onClick={() => handleReject(row._id)}
            disabled={mutatingId === row._id}
            className="px-3 py-1 text-xs bg-red-600 text-white rounded hover:bg-red-700 disabled:opacity-50"
          >
            Reject
          </button>
        </div>
      )
    )}
  ];

  return (
    <div>
      <h1 className="mb-6 text-2xl font-bold">KYC Review</h1>
      {error && <div className="mb-4 p-3 bg-red-50 text-red-600 border border-red-200 rounded" role="alert">{error}</div>}
      <DataTable columns={columns} data={rows} keyField="_id" />
    </div>
  );
}
