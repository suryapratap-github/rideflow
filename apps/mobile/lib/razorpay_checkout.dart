import 'dart:async';
import 'package:flutter/material.dart';
import 'package:razorpay_flutter/razorpay_flutter.dart';

/// Checkout success only means SDK returned; backend webhook is source of truth.
class RazorpayCheckout {
 static Future<String> open(Map<String,dynamic> order) async {
  final gateway=Razorpay(); final completer=Completer<String>();
  gateway.on(Razorpay.EVENT_PAYMENT_SUCCESS,(PaymentSuccessResponse result){if(!completer.isCompleted)completer.complete('Checkout completed; waiting for verified payment status.');});
  gateway.on(Razorpay.EVENT_PAYMENT_ERROR,(PaymentFailureResponse result){if(!completer.isCompleted)completer.complete('Payment failed or cancelled.');});
  gateway.on(Razorpay.EVENT_EXTERNAL_WALLET,(ExternalWalletResponse result){if(!completer.isCompleted)completer.complete('Wallet opened; waiting for verified payment status.');});
  try {
   gateway.open({'key':order['keyId'],'amount':order['amountPaise'],'currency':'INR','order_id':order['orderId'],'name':'RideFlow','description':'Ride payment'});
   return await completer.future.timeout(const Duration(minutes:5),onTimeout:()=> 'Checkout timed out; refresh payment status.');
  } finally {gateway.clear();}
 }
}
