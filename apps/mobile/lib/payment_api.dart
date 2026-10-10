import 'dart:convert';
import 'package:http/http.dart' as http;

/// Phase 14: cash records and UPI intent. Never infer settlement from an app launch.
class RidePaymentApi {
  RidePaymentApi(this.baseUrl, this.token);
  final String baseUrl;
  final String token;
  Future<Map<String, dynamic>> getPayment(String rideId) async =>
      _request('GET', '/mobile/rides/$rideId/payment');
  Future<Map<String, dynamic>> recordCashCollection(String rideId) async =>
      _request('POST', '/mobile/rides/$rideId/collect-cash');
  Future<Map<String, dynamic>> selectMethod(String rideId, String method) async =>
      _request('POST', '/mobile/rides/$rideId/select-payment', body: {'method': method});
  Future<Map<String, dynamic>> startUpi(String rideId) async =>
      _request('POST', '/mobile/rides/$rideId/upi-intent');
  Future<Map<String, dynamic>> getReceipt(String rideId) async =>
      _request('GET', '/mobile/rides/$rideId/receipt');
  Future<Map<String, dynamic>> _request(String method, String path, {Map<String, dynamic>? body}) async {
    final uri = Uri.parse('$baseUrl$path');
    final response = method == 'POST'
        ? await http.post(uri, headers: {'Authorization': 'Bearer $token', 'Content-Type': 'application/json'}, body: body == null ? null : jsonEncode(body))
        : await http.get(uri, headers: {'Authorization': 'Bearer $token'});
    if (response.statusCode < 200 || response.statusCode >= 300) {
      throw Exception('Payment request failed (${response.statusCode})');
    }
    return jsonDecode(response.body) as Map<String, dynamic>;
  }
}
