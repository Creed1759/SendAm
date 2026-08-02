const { registerWhatsAppJobs } = require('./whatsapp.jobs');
const { startDepositPoller } = require('./deposits.jobs');

const registerJobs = () => {
  const whatsappWorker = registerWhatsAppJobs();
  const depositPoller = startDepositPoller();
  return {
    whatsappWorker,
    stop: async () => {
      depositPoller.stop();
    },
  };
};

module.exports = {
  registerJobs,
};
