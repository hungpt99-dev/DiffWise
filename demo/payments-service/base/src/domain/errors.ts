export class PaymentError extends Error {
  constructor(message: string, readonly code: string) {
    super(message);
    this.name = 'PaymentError';
  }
}

export class ValidationError extends PaymentError {
  constructor(message: string) {
    super(message, 'validation_failed');
  }
}

export class PaymentNotFoundError extends PaymentError {
  constructor(id: string) {
    super(`Payment ${id} not found`, 'payment_not_found');
  }
}

export class PaymentDeclinedError extends PaymentError {
  constructor(reason: string) {
    super(`Payment declined: ${reason}`, 'payment_declined');
  }
}

export class InsufficientFundsError extends PaymentError {
  constructor() {
    super('Insufficient funds for refund', 'insufficient_funds');
  }
}
