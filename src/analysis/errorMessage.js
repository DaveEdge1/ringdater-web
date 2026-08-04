'use strict';
// Port of ringdater::RingdateR_error_message.
// In R this renders a text placeholder as a ggplot when data is missing. There
// is no plotting here, so we return an error-display descriptor. The message
// text/logic is reproduced exactly:
//   - default message  = "Can't display plot"
//   - plot.err must be logical, message must be a character string (else stop)
//   - plot.err TRUE  -> the "plot" descriptor (the text placeholder + style)
//   - plot.err FALSE -> the raw message string (R returns the.data[1,1])

const DEFAULT_MESSAGE = "Can't display plot";

function RingdateR_error_message(message = DEFAULT_MESSAGE, plot_err = true) {
  if (typeof plot_err !== 'boolean') {
    throw new Error('Warning RingdateR_error_message: plot.err not logical (TRUE?FLASE)');
  }
  if (typeof message !== 'string') {
    throw new Error('Warning RingdateR_error_message: message not a character string');
  }

  if (plot_err) {
    // descriptor mirroring the ggplot: red text label at (1,1), size 10
    return { message, x: 1, y: 1, colour: 'red', size: 10 };
  }
  return message;
}

module.exports = { RingdateR_error_message, DEFAULT_MESSAGE };
