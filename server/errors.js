// Errors whose message is safe to show to the person using the app. Anything
// else that reaches the HTTP layer is logged and answered with a generic 500.
function httpError(status, message) {
  return Object.assign(new Error(message), { status, expose: true });
}

module.exports = { httpError };
