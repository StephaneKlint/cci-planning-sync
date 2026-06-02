module.exports = (req, res) => {
  res.status(200).json({
    status: 'ok',
    message: 'CCI Planning Server is running!',
    timestamp: new Date().toISOString()
  });
};
