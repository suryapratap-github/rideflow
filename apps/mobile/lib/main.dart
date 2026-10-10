import 'package:firebase_core/firebase_core.dart';
import 'package:firebase_messaging/firebase_messaging.dart';
import 'package:geolocator/geolocator.dart';
import 'package:socket_io_client/socket_io_client.dart' as IO;
import 'package:image_picker/image_picker.dart';
import 'package:flutter_stripe/flutter_stripe.dart';
import 'razorpay_checkout.dart';
import 'package:flutter_map/flutter_map.dart';
import 'package:latlong2/latlong.dart';
import 'package:url_launcher/url_launcher.dart';
import 'dart:convert';
import 'dart:async';
import 'dart:math' as math;
import 'package:flutter/material.dart';
import 'package:http/http.dart' as http;
import 'package:google_fonts/google_fonts.dart';

String mobileToken = '';
String mobileRole = 'CUSTOMER';
const apiBase = String.fromEnvironment('API_BASE_URL', defaultValue: 'http://10.0.2.2:4000/api');
const navy = Color(0xFF0F172A), lime = Color(0xFFC7F464), blue = Color(0xFF3563E9), bg = Color(0xFFF8FAFC);
Future<void> main() async {
 WidgetsFlutterBinding.ensureInitialized();
 try{await Firebase.initializeApp();}catch(_){/* Firebase platform config is optional in development. */}
 runApp(const RideFlowApp());
}

class Api {
  static Future<dynamic> get(String path) async {
    final response = await http.get(Uri.parse('$apiBase/$path'),headers:mobileToken.isEmpty?{}:{'Authorization':'Bearer $mobileToken'}).timeout(const Duration(seconds: 8));
    if (response.statusCode != 200) throw Exception('API ${response.statusCode}');
    return jsonDecode(response.body);
  }
  static Future<dynamic> patch(String path, Map<String,dynamic> data) async {
    final response = await http.patch(Uri.parse('$apiBase/$path'),headers:{'Content-Type':'application/json',if(mobileToken.isNotEmpty)'Authorization':'Bearer $mobileToken'},body:jsonEncode(data)).timeout(const Duration(seconds:8));
    if(response.statusCode < 200 || response.statusCode >= 300) throw Exception('API ${response.statusCode}: ${response.body}');
    return jsonDecode(response.body);
  }
  static Future<dynamic> delete(String path, Map<String,dynamic> data) async {
    final response=await http.delete(Uri.parse('$apiBase/$path'),
      headers:{'Content-Type':'application/json',if(mobileToken.isNotEmpty)'Authorization':'Bearer $mobileToken'},
      body:jsonEncode(data)).timeout(const Duration(seconds:8));
    if(response.statusCode<200||response.statusCode>=300)throw Exception('API ${response.statusCode}');
    return jsonDecode(response.body);
  }
  static Future<dynamic> post(String path, Map<String,dynamic> data) async {
    final response = await http.post(Uri.parse('$apiBase/$path'),headers:{'Content-Type':'application/json',if(mobileToken.isNotEmpty)'Authorization':'Bearer $mobileToken'},body:jsonEncode(data)).timeout(const Duration(seconds: 8));
    if (response.statusCode < 200 || response.statusCode >= 300) throw Exception('API ${response.statusCode}: ${response.body}');
    return jsonDecode(response.body);
  }
}
class RideFlowApp extends StatelessWidget {
  const RideFlowApp({super.key});
  @override Widget build(BuildContext context) => MaterialApp(title:'RideFlow',debugShowCheckedModeBanner:false,theme:ThemeData(useMaterial3:true,scaffoldBackgroundColor:bg,colorScheme:ColorScheme.fromSeed(seedColor:blue),textTheme:GoogleFonts.interTextTheme(),appBarTheme:const AppBarTheme(backgroundColor:bg,foregroundColor:navy,elevation:0)),home:const MobileLogin());
}
class Shell extends StatefulWidget {const Shell({super.key});@override State<Shell> createState()=>_ShellState();}
class _ShellState extends State<Shell> {
  int tab=0; bool driverMode=mobileRole=='DRIVER';
  StreamSubscription<RemoteMessage>? notificationTap;
  @override void initState(){super.initState();
   notificationTap=FirebaseMessaging.onMessageOpenedApp.listen(openNotification);
   if(Firebase.apps.isNotEmpty){
    FirebaseMessaging.instance.getInitialMessage().then((message){if(message!=null&&mounted)openNotification(message);}).catchError((_){return;});
   }
  }
  Future<void> openNotification(RemoteMessage message)async{
   if(!mounted||!['ride_status','chat_message'].contains(message.data['type']))return;
   final id=message.data['rideId'];
   if(id is! String||id.isEmpty||mobileToken.isEmpty)return;
   try{
    // The authenticated ride endpoint validates ownership; never navigate
    // based only on untrusted notification content.
    final ride=await Api.get('mobile/rides/${Uri.encodeComponent(id)}');
    if(!mounted||ride is! Map||ride['id']!=id)return;
    if(message.data['type']=='chat_message'&&['ASSIGNED','ARRIVING','IN_PROGRESS'].contains(ride['status'])){
     Navigator.push(context,MaterialPageRoute(builder:(_)=>RideCommunicationScreen(rideId:id,reference:(ride['reference']??'Ride').toString())));return;
    }
    if(driverMode){setState(()=>tab=0);return;}
    if(['ASSIGNED','ARRIVING','IN_PROGRESS'].contains(ride['status'])){
     Navigator.push(context,MaterialPageRoute(builder:(_)=>RideTrackingScreen(rideId:id,reference:(ride['reference']??'Ride').toString())));
    }else{
     setState(()=>tab=1);
    }
   }catch(_){if(mounted)ScaffoldMessenger.of(context).showSnackBar(const SnackBar(content:Text('Ride update unavailable. Open Trips to refresh.')));}
  }
  @override void dispose(){notificationTap?.cancel();super.dispose();}

  @override Widget build(BuildContext context) => Scaffold(appBar:AppBar(title:Row(children:[Container(padding:const EdgeInsets.symmetric(horizontal:10,vertical:4),decoration:BoxDecoration(color:navy,borderRadius:BorderRadius.circular(9)),child:const Text('R',style:TextStyle(color:lime,fontWeight:FontWeight.w900))),const SizedBox(width:10),const Text('rideflow',style:TextStyle(fontWeight:FontWeight.w800,letterSpacing:-1))]),actions:[TextButton(onPressed:null,child:Text(driverMode?'Driver account':'Customer account'))]),body:driverMode?(tab==0?const DriverHome():tab==1?const CourierParcelScreen():const Profile(driver:true)):(tab==0?const CustomerHome():tab==1?const TripList(driver:false):const Profile(driver:false)),bottomNavigationBar:NavigationBar(selectedIndex:tab,onDestinationSelected:(i)=>setState(()=>tab=i),destinations:[NavigationDestination(icon:Icon(driverMode?Icons.speed:Icons.home_outlined),label:'Home'),const NavigationDestination(icon:Icon(Icons.receipt_long_outlined),label:'Trips'),const NavigationDestination(icon:Icon(Icons.person_outline),label:'Account')]));
}
class SectionCard extends StatelessWidget {final Widget child;const SectionCard({super.key,required this.child});@override Widget build(BuildContext context)=>Container(margin:const EdgeInsets.only(bottom:15),padding:const EdgeInsets.all(19),decoration:BoxDecoration(color:Colors.white,borderRadius:BorderRadius.circular(18),border:Border.all(color:const Color(0xFFE7EBF2))),child:child);}
class CustomerHome extends StatefulWidget {const CustomerHome({super.key});@override State<CustomerHome> createState()=>_CustomerHomeState();}
class _CustomerHomeState extends State<CustomerHome> {
  final pickup=TextEditingController(text:'Civil Lines, Jaipur');final destination=TextEditingController(text:'Jaipur Railway Station');String type='MINI';bool poolingEnabled=true;bool poolingRequested=false;String message='';bool busy=false; LatLng? selectedPickup; LatLng? selectedDestination; Map<String,dynamic>? quote; String? selectedCityId; List<dynamic> cityOptions=[];
  @override void dispose(){pickup.dispose();destination.dispose();super.dispose();}
  Future<void> selectPickup() async {
    final result=await Navigator.push<LatLng>(context,MaterialPageRoute(builder:(_)=>PickupMapPicker(initial:selectedPickup)));
    if(result!=null && mounted)setState((){selectedPickup=result;pickup.text='Map pin: ${result.latitude.toStringAsFixed(5)}, ${result.longitude.toStringAsFixed(5)}';});
  }
  Future<void> selectDestination() async {
    final result=await Navigator.push<LatLng>(context,MaterialPageRoute(builder:(_)=>PickupMapPicker(initial:selectedDestination,title:'Choose destination point',confirmLabel:'Confirm destination')));
    if(result!=null&&mounted)setState((){selectedDestination=result;destination.text='Map pin: ${result.latitude.toStringAsFixed(5)}, ${result.longitude.toStringAsFixed(5)}';quote=null;});
  }
  Future<void> loadCities() async {try{final result=await Api.get('mobile/cities') as List; if(mounted)setState((){cityOptions=result;selectedCityId=result.isNotEmpty?result.first['id'] as String:null;quote=null;});}catch(e){if(mounted)setState(()=>message='Cities unavailable: $e');}}
  @override void initState(){super.initState();loadCities();loadPooling();}
  Future<void> loadPooling() async {try{final r=await Api.get('mobile/pooling/availability');if(mounted)setState((){poolingEnabled=r['enabled']==true;if(!poolingEnabled)poolingRequested=false;});}catch(_){if(mounted)setState(()=>poolingEnabled=false);}}
  Future<void> estimate() async {if(selectedPickup==null||selectedDestination==null){setState(()=>message='Select pickup and destination map pins first');return;}setState((){busy=true;message='';});try{if(selectedCityId==null)throw Exception('Choose a city');final result=await Api.post('mobile/fare-quote',{'cityId':selectedCityId,'type':type,'pickupLatitude':selectedPickup!.latitude,'pickupLongitude':selectedPickup!.longitude,'dropoffLatitude':selectedDestination!.latitude,'dropoffLongitude':selectedDestination!.longitude});if(mounted)setState(()=>quote=Map<String,dynamic>.from(result));}catch(e){if(mounted)setState(()=>message='Quote unavailable: $e');}finally{if(mounted)setState(()=>busy=false);}}
  Future<void> book() async {if(quote==null||quote!['available']!=true||quote!['quoteId']==null){setState(()=>message='Preview a valid fare before booking');return;}setState((){busy=true;message='';});try{if(selectedCityId==null)throw Exception('Choose a city');final ride=await Api.post('mobile/rides',{'quoteId':quote!['quoteId'],'cityId':selectedCityId,'pickup':pickup.text,'dropoff':destination.text,'type':type,'poolingRequested':poolingEnabled&&poolingRequested,if(selectedPickup!=null)'pickupLatitude':selectedPickup!.latitude,if(selectedPickup!=null)'pickupLongitude':selectedPickup!.longitude,if(selectedDestination!=null)'dropoffLatitude':selectedDestination!.latitude,if(selectedDestination!=null)'dropoffLongitude':selectedDestination!.longitude});if(!mounted)return;Navigator.push(context,MaterialPageRoute(builder:(_)=>RideTracking(ride:ride)));}catch(e){setState(()=>message='Booking unavailable: $e');}finally{if(mounted)setState(()=>busy=false);}}
  @override Widget build(BuildContext context)=>ListView(padding:const EdgeInsets.all(20),children:[const Text('Good morning 👋',style:TextStyle(fontSize:13,color:Colors.black54)),const SizedBox(height:6),const Text('Where to today?',style:TextStyle(fontSize:29,fontWeight:FontWeight.w800)),const SizedBox(height:20),const RideMap(latitude:26.9124,longitude:75.7873,caption:'Jaipur map preview · Select exact pickup GPS before distance matching'),const SizedBox(height:18),SectionCard(child:Column(crossAxisAlignment:CrossAxisAlignment.start,children:[const Text('Book your ride',style:TextStyle(fontSize:18,fontWeight:FontWeight.w800)),const SizedBox(height:15),DropdownButtonFormField<String>(value:selectedCityId,decoration:const InputDecoration(labelText:'Service city',border:OutlineInputBorder()),items:cityOptions.map<DropdownMenuItem<String>>((c)=>DropdownMenuItem(value:c['id'] as String,child:Text(c['name'] as String))).toList(),onChanged:(v)=>setState((){selectedCityId=v;quote=null;})),const SizedBox(height:12),TextField(controller:pickup,decoration:const InputDecoration(prefixIcon:Icon(Icons.my_location,color:blue),labelText:'Pickup location',border:OutlineInputBorder())),const SizedBox(height:8),OutlinedButton.icon(onPressed:selectPickup,icon:const Icon(Icons.place),label:Text(selectedPickup==null?'Choose exact pickup on map':'Change pickup map pin')),const SizedBox(height:12),TextField(controller:destination,decoration:const InputDecoration(prefixIcon:Icon(Icons.location_on_outlined),labelText:'Destination',border:OutlineInputBorder())),const SizedBox(height:8),OutlinedButton.icon(onPressed:selectDestination,icon:const Icon(Icons.flag_outlined),label:Text(selectedDestination==null?'Choose destination on map':'Change destination map pin')),const SizedBox(height:16),const Text('Choose vehicle',style:TextStyle(fontWeight:FontWeight.w700)),const SizedBox(height:10),Wrap(spacing:8,children:['BIKE','AUTO','MINI','SEDAN','SUV'].map((v)=>ChoiceChip(label:Text(v),selected:type==v,onSelected:(_)=>setState((){type=v;quote=null;}))).toList()),const SizedBox(height:14),if(poolingEnabled&&['MINI','SEDAN','SUV'].contains(type))SwitchListTile(title:const Text('Request shared ride / pooling'),subtitle:const Text('Request only · shared matching and discounts not active yet'),value:poolingRequested,onChanged:(v)=>setState(()=>poolingRequested=v)),OutlinedButton(onPressed:busy?null:estimate,child:const Text('Preview route and estimated fare')),if(quote!=null)FarePreview(quote:quote!),const SizedBox(height:15),SizedBox(width:double.infinity,height:54,child:FilledButton(style:FilledButton.styleFrom(backgroundColor:navy),onPressed:busy||quote==null||quote!['available']!=true?null:book,child:Text(busy?'Booking…':'Request $type ride'))),if(message.isNotEmpty)Padding(padding:const EdgeInsets.only(top:12),child:Text(message,style:const TextStyle(color:Colors.red)))])),OutlinedButton.icon(onPressed:()=>Navigator.push(context,MaterialPageRoute(builder:(_)=>const ParcelDeliveryScreen())),icon:const Icon(Icons.local_shipping_outlined),label:const Text('Parcel delivery')),const SizedBox(height:12),const Text('Available in 10 Indian cities · Demo account',style:TextStyle(color:Colors.black45,fontSize:11))]);
}
class RideTracking extends StatefulWidget {final dynamic ride;const RideTracking({super.key,required this.ride});@override State<RideTracking> createState()=>_RideTrackingState();}
class _RideTrackingState extends State<RideTracking>{late Map<String,dynamic> ride;Timer? timer;String? pickupCode;String? expires;String message='';Map<String,dynamic>? location;Map<String,dynamic>? route;bool busy=false;
 @override void initState(){super.initState();ride=Map<String,dynamic>.from(widget.ride);refresh();timer=Timer.periodic(const Duration(seconds:6),(_)=>refresh());}
 @override void dispose(){timer?.cancel();super.dispose();}
 Future<void> refresh()async{try{final data=await Api.get('mobile/rides/${ride['id']}');Map<String,dynamic>? pos;if(['ASSIGNED','ARRIVING','IN_PROGRESS'].contains(data['status'])){final x=await Api.get('mobile/rides/${ride['id']}/driver-location');if(x is Map)pos=Map<String,dynamic>.from(x);}Map<String,dynamic>? nextRoute;
 if(pos!=null && data['pickupLatitude']!=null && data['pickupLongitude']!=null && ['ASSIGNED','ARRIVING'].contains(data['status'])){
  try{final r=await Api.get('mobile/rides/${ride['id']}/pickup-route');if(r is Map)nextRoute=Map<String,dynamic>.from(r);}catch(_){/* No verified route; keep driver marker. */}
 }
 if(mounted)setState((){ride=Map<String,dynamic>.from(data);location=pos;route=nextRoute;});}catch(e){if(mounted)setState(()=>message='Unable to refresh trip: $e');}}
 Future<void> generateCode()async{setState((){busy=true;message='';});try{final r=await Api.post('mobile/rides/${ride['id']}/pickup-code',{});if(mounted)setState((){pickupCode=r['code'];expires=r['expiresAt'];});}catch(e){if(mounted)setState(()=>message='Code unavailable: $e');}finally{if(mounted)setState(()=>busy=false);}}
 @override Widget build(BuildContext context)=>Scaffold(appBar:AppBar(title:const Text('Your ride')),body:ListView(padding:const EdgeInsets.all(20),children:[const Text('Live trip status',style:TextStyle(fontSize:25,fontWeight:FontWeight.w800)),const SizedBox(height:12),SectionCard(child:Column(crossAxisAlignment:CrossAxisAlignment.start,children:[Text('Reference: ${ride['reference']}'),const SizedBox(height:8),Text('Pickup: ${ride['pickup']}'),const SizedBox(height:8),Text('Destination: ${ride['dropoff']}'),const SizedBox(height:8),Text('Status: ${ride['status']}',style:const TextStyle(fontWeight:FontWeight.bold)),if(ride['driver']!=null)Text('Driver: ${ride['driver']['name']}'),if(ride['vehicle']!=null)Text('Vehicle: ${ride['vehicle']['plate']}')])),if(location!=null)TrackingRouteMap(driver:LatLng((location!['latitude'] as num).toDouble(),(location!['longitude'] as num).toDouble()),pickup:ride['pickupLatitude']!=null&&ride['pickupLongitude']!=null?LatLng((ride['pickupLatitude'] as num).toDouble(),(ride['pickupLongitude'] as num).toDouble()):null,route:route),if(location!=null)SectionCard(child:Column(crossAxisAlignment:CrossAxisAlignment.start,children:[const Text('Latest driver location',style:TextStyle(fontWeight:FontWeight.bold)),Text('${location!['latitude']}, ${location!['longitude']}'),Text('Updated: ${location!['updatedAt']}',style:const TextStyle(fontSize:12)),TextButton.icon(onPressed:()async{final lat=location!['latitude'];final lon=location!['longitude'];final uri=Uri.parse('https://www.google.com/maps/search/?api=1&query=$lat,$lon');if(await canLaunchUrl(uri))await launchUrl(uri,mode:LaunchMode.externalApplication);},icon:const Icon(Icons.map_outlined),label:const Text('View driver location on map'))])),if(ride['status']=='ARRIVING')SectionCard(child:Column(children:[const Text('Share pickup code only after checking driver and vehicle.'),const SizedBox(height:12),FilledButton(onPressed:busy?null:generateCode,child:const Text('Show pickup code')),if(pickupCode!=null)...[Text(pickupCode!,style:const TextStyle(fontSize:35,fontWeight:FontWeight.bold)),Text('Expires: $expires')]])),if(message.isNotEmpty)Text(message,style:const TextStyle(color:Colors.red)),const Text('Driver position refreshes every six seconds. Routing is an estimate, not navigation or background GPS.',style:TextStyle(fontSize:12,color:Colors.black54))]));}
class DriverHome extends StatefulWidget {const DriverHome({super.key});@override State<DriverHome> createState()=>_DriverHomeState();}
class _DriverHomeState extends State<DriverHome> with WidgetsBindingObserver {
 bool busy=false; String notice=''; late Future<dynamic> rides; StreamSubscription<Position>? gpsSubscription; bool sharingGps=false; bool gpsSending=false; DateTime? lastGpsSent,lastGpsObservation;
 int gpsUploadCount=0,gpsFailureCount=0,gpsFilteredCount=0;
 Duration gpsUploadInterval=const Duration(seconds:5);
 Duration intervalForSpeed(double speed){
  if(!speed.isFinite||speed<0)return const Duration(seconds:5);
  if(speed<0.8)return const Duration(seconds:20);
  if(speed<4)return const Duration(seconds:10);
  return const Duration(seconds:5);
 }

 @override void initState(){super.initState();WidgetsBinding.instance.addObserver(this);refresh();}
 void refresh(){rides=Api.get('mobile/rides');}
 @override void dispose(){WidgetsBinding.instance.removeObserver(this);gpsSubscription?.cancel();super.dispose();}
 @override void didChangeAppLifecycleState(AppLifecycleState state){if(state!=AppLifecycleState.resumed && sharingGps)stopGps('GPS paused while app is not in foreground');}
 void stopGps(String text){gpsSubscription?.cancel();gpsSubscription=null;if(mounted)setState((){sharingGps=false;notice=text;});}
 Future<void> startGps() async {
  try {
   if(!await Geolocator.isLocationServiceEnabled())throw Exception('Enable device location services');
   var permission=await Geolocator.checkPermission();
   if(permission==LocationPermission.denied)permission=await Geolocator.requestPermission();
   if(permission==LocationPermission.denied||permission==LocationPermission.deniedForever)throw Exception('Location permission required');
   if(!mounted)return;
   setState((){sharingGps=true;notice='Sharing foreground GPS while app is open';});
   gpsSubscription=Geolocator.getPositionStream(locationSettings:const LocationSettings(accuracy:LocationAccuracy.high,distanceFilter:8)).listen((position)=>sendGpsPosition(position),onError:(Object error)=>stopGps('GPS stopped: $error'),cancelOnError:true);
  }catch(e){stopGps('GPS unavailable: $e');}
 }
 Future<void> sendGpsPosition(Position pos) async {
  if(!sharingGps||gpsSending)return;
  if(!pos.accuracy.isFinite||pos.accuracy<0||pos.accuracy>200){gpsFilteredCount++;return;}
  final now=DateTime.now();
  if(lastGpsSent!=null&&now.difference(lastGpsSent!)<gpsUploadInterval)return;
  if(pos.timestamp.isAfter(now.add(const Duration(seconds:5)))||now.difference(pos.timestamp)>const Duration(seconds:30)){gpsFilteredCount++;return;}
  if(lastGpsObservation!=null&&!pos.timestamp.isAfter(lastGpsObservation!)){gpsFilteredCount++;return;}
  gpsSending=true;
  try {await Api.patch('mobile/driver/location',{'latitude':pos.latitude,'longitude':pos.longitude,'accuracyMeters':pos.accuracy});lastGpsSent=DateTime.now();lastGpsObservation=pos.timestamp;gpsUploadInterval=pos.accuracy>75?const Duration(seconds:5):intervalForSpeed(pos.speed);gpsUploadCount++;if(mounted)setState(()=>notice='GPS shared · $gpsUploadCount sent · $gpsFailureCount failed · $gpsFilteredCount filtered · next ≥${gpsUploadInterval.inSeconds}s');}
  catch(e){gpsFailureCount++;if(mounted&&sharingGps)setState(()=>notice='GPS upload failed; waiting for next fix: $e');}
  finally{gpsSending=false;}
 }

 void toggleGps(){if(sharingGps){stopGps('GPS sharing stopped');}else{startGps();}}

 Future<void> action(String rideId,String verb)async{
  setState((){busy=true;notice='';});
  try{await Api.post('mobile/rides/$rideId/$verb',{});setState((){notice=verb=='accept'?'Ride accepted. Navigate to pickup.':'Offer declined; ride returned to dispatch.';refresh();});}
  catch(e){setState(()=>notice='Action failed: $e');}
  finally{if(mounted)setState(()=>busy=false);}
 }
 Future<void> updateStatus(String id,String status)async{setState((){busy=true;notice='';});try{await Api.patch('mobile/rides/$id/status',{'status':status});if(mounted)setState((){notice='Trip updated to $status';refresh();});}catch(e){if(mounted)setState(()=>notice='Status update failed: $e');}finally{if(mounted)setState(()=>busy=false);}}
 @override Widget build(BuildContext context)=>ListView(padding:const EdgeInsets.all(20),children:[
  const Text('Driver workspace',style:TextStyle(fontSize:27,fontWeight:FontWeight.w800)),
  const SizedBox(height:8),const Text('Assigned requests require explicit acceptance',style:TextStyle(color:Colors.black54)),
  const SizedBox(height:12),OutlinedButton.icon(onPressed:toggleGps,icon:Icon(sharingGps?Icons.location_off:Icons.my_location),label:Text(sharingGps?'Stop GPS sharing':'Share live GPS (foreground, adaptive)')),const SizedBox(height:18),FilledButton(onPressed:()=>setState(refresh),child:const Text('Refresh requests')),
  if(notice.isNotEmpty)Padding(padding:const EdgeInsets.all(12),child:Text(notice)),
  FutureBuilder<dynamic>(future:rides,builder:(context,s){
   if(s.hasError)return Text('API unavailable: ${s.error}');
   if(!s.hasData)return const Center(child:CircularProgressIndicator());
   final list=s.data as List;
   if(list.isEmpty)return const SectionCard(child:Text('No assigned rides yet.'));
   return Column(children:list.take(20).map((r)=>SectionCard(child:Column(crossAxisAlignment:CrossAxisAlignment.start,children:[
    Text('${r['reference']} · ${r['status']}',style:const TextStyle(fontWeight:FontWeight.w800)),
    const SizedBox(height:9),Text('${r['pickup']} → ${r['dropoff']}'),
    if(r['status']=='ASSIGNED')Padding(padding:const EdgeInsets.only(top:14),child:Row(children:[
     Expanded(child:FilledButton(onPressed:busy?null:()=>action(r['id'],'accept'),child:const Text('Accept'))),
     const SizedBox(width:9),Expanded(child:OutlinedButton(onPressed:busy?null:()=>action(r['id'],'decline'),child:const Text('Decline')))
    ])),
    if(r['poolGroupId']!=null)Padding(padding:const EdgeInsets.only(top:10),child:OutlinedButton.icon(onPressed:()=>Navigator.push(context,MaterialPageRoute(builder:(_)=>PoolingStopsScreen(groupId:r['poolGroupId'].toString(),driver:true))),icon:const Icon(Icons.route),label:const Text('Open shared-ride stops'))),
    if(r['poolGroupId']==null&&r['status']=='IN_PROGRESS')Padding(padding:const EdgeInsets.only(top:12),child:FilledButton(onPressed:busy?null:() => updateStatus(r['id'],'COMPLETED'),child:const Text('Complete trip'))),
    if(r['poolGroupId']==null&&r['status']=='ARRIVING')Padding(padding:const EdgeInsets.only(top:12),child:PickupVerification(rideId:r['id'],onVerified:()=>setState(refresh)))
   ])) ).toList());
  })
 ]);
}
// Phase 46: pooled stop progression uses the server-authoritative stop index.
class PoolingStopsScreen extends StatefulWidget {
 final String groupId; final bool driver;
 const PoolingStopsScreen({super.key,required this.groupId,required this.driver});
 @override State<PoolingStopsScreen> createState()=>_PoolingStopsScreenState();
}
class _PoolingStopsScreenState extends State<PoolingStopsScreen> {
 Map<String,dynamic>? data; String notice=''; bool busy=false; Timer? timer;
 final otp=TextEditingController(); String? pickupCode;
 @override void initState(){super.initState();refresh();timer=Timer.periodic(const Duration(seconds:12),(_)=>refresh());}
 @override void dispose(){timer?.cancel();otp.dispose();super.dispose();}
 Future<void> refresh()async{try{final r=await Api.get('mobile/pooling/groups/${widget.groupId}/stops');if(mounted)setState(()=>data=Map<String,dynamic>.from(r));}catch(e){if(mounted)setState(()=>notice='Unable to load pooling stops: $e');}}
 Future<void> issueCode()async{setState(()=>busy=true);try{final r=await Api.post('mobile/pooling/groups/${widget.groupId}/pickup-code',{});if(mounted)setState((){pickupCode=r['code']?.toString();notice='Show this code only to your assigned driver. Expires: ${r['expiresAt']}';});}catch(e){if(mounted)setState(()=>notice='Pickup code unavailable: $e');}finally{if(mounted)setState(()=>busy=false);}}
 Future<void> advance(String kind)async{setState(()=>busy=true);try{await Api.post('mobile/pooling/groups/${widget.groupId}/advance',kind=='PICKUP'?{'code':otp.text.trim()}:{});otp.clear();if(mounted)setState(()=>notice='Stop confirmed');await refresh();}catch(e){if(mounted)setState(()=>notice='Cannot advance stop: $e');}finally{if(mounted)setState(()=>busy=false);}}
 @override Widget build(BuildContext context){final stops=(data?['stops'] as List?)??[];final index=(data?['currentStopIndex'] as num?)?.toInt()??0;final active=index<stops.length?stops[index] as Map:null;
 return Scaffold(appBar:AppBar(title:Text(widget.driver?'Driver pooling stops':'Shared ride stops')),body:ListView(padding:const EdgeInsets.all(18),children:[
 Text('Group status: ${data?['status']??'Loading…'}',style:const TextStyle(fontWeight:FontWeight.bold)),const SizedBox(height:12),
 ...stops.map((s)=>Card(child:ListTile(leading:Icon(s['completed']==true?Icons.check_circle:Icons.place),title:Text('${s['kind']} · ${s['address']}'),subtitle:Text(s['completed']==true?'Completed':s['index']==index?'Next stop':'Upcoming')))),
 if(!widget.driver&&data!=null&&index<stops.length)FilledButton(onPressed:busy?null:issueCode,child:const Text('Get my passenger pickup code')),
 if(pickupCode!=null&&!widget.driver)SelectableText('Your pickup OTP: $pickupCode',style:const TextStyle(fontSize:24,fontWeight:FontWeight.bold)),
 if(widget.driver&&active!=null)...[Text('Current stop: ${active['kind']} · ${active['address']}'),if(active['kind']=='PICKUP')TextField(controller:otp,maxLength:6,keyboardType:TextInputType.number,decoration:const InputDecoration(labelText:'Passenger six-digit pickup code')),FilledButton(onPressed:busy?null:()=>advance(active['kind'].toString()),child:Text(active['kind']=='PICKUP'?'Verify passenger pickup':'Confirm passenger drop-off'))],
 if(notice.isNotEmpty)Padding(padding:const EdgeInsets.only(top:12),child:Text(notice)),OutlinedButton(onPressed:refresh,child:const Text('Refresh stops'))]));
 }
}
class PickupVerification extends StatefulWidget {final String rideId;final VoidCallback onVerified;const PickupVerification({super.key,required this.rideId,required this.onVerified});@override State<PickupVerification> createState()=>_PickupVerificationState();}
class _PickupVerificationState extends State<PickupVerification>{final code=TextEditingController();String message='';bool busy=false,verified=false;
 @override void dispose(){code.dispose();super.dispose();}
 Future<void> verify()async{setState((){busy=true;message='';});try{await Api.post('mobile/rides/${widget.rideId}/verify-pickup',{'code':code.text});setState((){message='Pickup verified. You can start the trip.';verified=true;});widget.onVerified();}catch(e){setState(()=>message='Verification failed: $e');}finally{if(mounted)setState(()=>busy=false);}}
 @override Widget build(BuildContext context)=>Column(children:[const SizedBox(height:8),TextField(controller:code,maxLength:4,keyboardType:TextInputType.number,decoration:const InputDecoration(labelText:'Passenger pickup code',border:OutlineInputBorder())),FilledButton(onPressed:busy?null:verify,child:Text(busy?'Checking…':'Verify pickup code')),if(verified)FilledButton(onPressed:busy?null:()async{setState(()=>busy=true);try{await Api.patch('mobile/rides/${widget.rideId}/status',{'status':'IN_PROGRESS'});widget.onVerified();}catch(e){if(mounted)setState(()=>message='Start failed: $e');}finally{if(mounted)setState(()=>busy=false);}},child:const Text('Start trip')),if(message.isNotEmpty)Text(message)]);
}
class TripList extends StatelessWidget {final bool driver;const TripList({super.key,required this.driver});@override Widget build(BuildContext context)=>FutureBuilder<dynamic>(future:Future.wait([Api.get('mobile/rides'),Api.get('mobile/communications/unread-summary')]),builder:(context,s)=>ListView(padding:const EdgeInsets.all(20),children:[Text(driver?'Driver trips':'Your trips',style:const TextStyle(fontSize:27,fontWeight:FontWeight.w800)),const SizedBox(height:18),if(s.hasError)Text('API unavailable: ${s.error}') else if(!s.hasData)const CircularProgressIndicator() else ...((s.data as List)[0] as List).take(30).map((r)=>SectionCard(child:Column(crossAxisAlignment:CrossAxisAlignment.start,children:[Text('${r['reference']} · ${r['status']}',style:const TextStyle(fontWeight:FontWeight.w700)),const SizedBox(height:8),Text('${r['pickup']} → ${r['dropoff']}'),const SizedBox(height:6),Text('₹${((r['farePaise'] as num)/100).toStringAsFixed(0)}',style:const TextStyle(color:blue,fontWeight:FontWeight.w700)),if(['ASSIGNED','ARRIVING','IN_PROGRESS'].contains(r['status']))OutlinedButton.icon(onPressed:()=>Navigator.push(context,MaterialPageRoute(builder:(_)=>RideCommunicationScreen(rideId:r['id'].toString(),reference:r['reference'].toString()))),icon:const Icon(Icons.chat_bubble_outline),label:Builder(builder:(context){final summary=(s.data as List)[1];final counts=summary is Map?summary['counts']:null;final n=counts is Map?(counts[r['id'].toString()] as num?)?.toInt()??0:0;return Text(n>0?'Chat / Call · $n unread':'Chat / Call');})), if(!driver&&['ASSIGNED','ARRIVING','IN_PROGRESS'].contains(r['status']))OutlinedButton.icon(onPressed:()=>Navigator.push(context,MaterialPageRoute(builder:(_)=>RideTrackingScreen(rideId:r['id'].toString(),reference:r['reference'].toString()))),icon:const Icon(Icons.location_searching),label:const Text('Track live ride')), if(!driver&&r['poolGroupId']!=null)OutlinedButton.icon(onPressed:()=>Navigator.push(context,MaterialPageRoute(builder:(_)=>PoolingStopsScreen(groupId:r['poolGroupId'].toString(),driver:false))),icon:const Icon(Icons.people),label:const Text('Shared-ride stops & pickup OTP')),if(!driver&&r['poolGroupId']!=null)OutlinedButton.icon(onPressed:()=>Navigator.push(context,MaterialPageRoute(builder:(_)=>PoolingFareScreen(groupId:r['poolGroupId'].toString()))),icon:const Icon(Icons.currency_rupee),label:const Text('Review shared-ride fare')),if(!driver&&['REQUESTED','MATCHING','ASSIGNED','ARRIVING'].contains(r['status']))OutlinedButton.icon(onPressed:()=>Navigator.push(context,MaterialPageRoute(builder:(_)=>CouponPreviewScreen(rideId:r['id'].toString()))),icon:const Icon(Icons.local_offer_outlined),label:const Text('Coupon preview & apply')),if(!driver&&r['status']=='COMPLETED')OutlinedButton.icon(onPressed:()=>Navigator.push(context,MaterialPageRoute(builder:(_)=>RideTipScreen(rideId:r['id'].toString()))),icon:const Icon(Icons.volunteer_activism_outlined),label:const Text('Record a tip (not charged)')),if(!driver&&r['poolGroupId']==null)Padding(padding:const EdgeInsets.only(top:10),child:OutlinedButton.icon(onPressed:()=>showDialog(context:context,builder:(context)=>RidePaymentDialog(rideId:r['id'].toString(),completed:r['status']=='COMPLETED')),icon:const Icon(Icons.payments_outlined),label:const Text('Payment & receipt')))]))]));}
class PushOptIn extends StatefulWidget {const PushOptIn({super.key});@override State<PushOptIn> createState()=>_PushOptInState();}
class _PushOptInState extends State<PushOptIn> {
 String info='Notifications are off until you enable them.';
 StreamSubscription<String>? tokenRefresh;
 String? registeredToken;
 @override void dispose(){tokenRefresh?.cancel();super.dispose();}
 Future<void> registerToken(String token)async{
  if(mobileToken.isEmpty)return;
  await Api.post('mobile/push/token',{'token':token,'platform':Theme.of(context).platform==TargetPlatform.iOS?'ios':'android'});
  registeredToken=token;
 }
 Future<void> enable()async{
  try{
   if(Firebase.apps.isEmpty)await Firebase.initializeApp();
   final messaging=FirebaseMessaging.instance;
   final settings=await messaging.requestPermission(alert:true,badge:true,sound:true);
   if(settings.authorizationStatus!=AuthorizationStatus.authorized&&settings.authorizationStatus!=AuthorizationStatus.provisional){
    if(mounted)setState(()=>info='Notification permission not granted');return;
   }
   final token=await messaging.getToken();
   if(token==null)throw StateError('Push token not available');
   await registerToken(token);
   await tokenRefresh?.cancel();
   tokenRefresh=messaging.onTokenRefresh.listen((next){registerToken(next).catchError((_){return;});});
   if(mounted)setState(()=>info='Push notifications enabled for this account');
  }catch(e){if(mounted)setState(()=>info='Push setup unavailable. Configure Firebase for Android/iOS. $e');}
 }
 Future<void> disable()async{
  try{
   final token=registeredToken;
   if(token!=null)await Api.delete('mobile/push/token',{'token':token,'platform':Theme.of(context).platform==TargetPlatform.iOS?'ios':'android'});
   await tokenRefresh?.cancel();tokenRefresh=null;registeredToken=null;
   if(mounted)setState(()=>info='Push notifications disabled for this account');
  }catch(e){if(mounted)setState(()=>info='Could not unregister notifications: $e');}
 }
 @override Widget build(BuildContext context)=>SectionCard(child:Column(crossAxisAlignment:CrossAxisAlignment.start,children:[
  const Text('Ride notifications',style:TextStyle(fontWeight:FontWeight.bold)),
  Text(info,style:const TextStyle(fontSize:12)),
  Wrap(spacing:8,children:[OutlinedButton(onPressed:enable,child:const Text('Enable notifications')),TextButton(onPressed:disable,child:const Text('Disable'))])
 ]));
}
class NotificationInbox extends StatefulWidget {const NotificationInbox({super.key});@override State<NotificationInbox> createState()=>_NotificationInboxState();}
class _NotificationInboxState extends State<NotificationInbox> {
 List<dynamic> entries=[];bool loading=false;String error='';bool marketing=false;
 @override void initState(){super.initState();reload();}
 Future<void> reload()async{
  if(mobileToken.isEmpty)return;
  setState(()=>loading=true);
  try{final inbox=await Api.get('mobile/push/inbox') as List;
   final preferences=await Api.get('mobile/push/preferences');
   if(mounted)setState((){entries=inbox;marketing=preferences['marketingEnabled']==true;error='';});
  }catch(e){if(mounted)setState(()=>error='Notifications unavailable: $e');}
  finally{if(mounted)setState(()=>loading=false);}
 }
 Future<void> setMarketing(bool enabled)async{
  try{await Api.patch('mobile/push/preferences',{'marketingEnabled':enabled});if(mounted)setState(()=>marketing=enabled);}
  catch(e){if(mounted)setState(()=>error='Preference update failed: $e');}
 }
 Future<void> openItem(dynamic item)async{
  try{await Api.patch('mobile/push/inbox/${Uri.encodeComponent(item['id'].toString())}/read',{});
   if(!mounted)return;
   final rideId=item['rideId'];
   if(rideId is String&&rideId.isNotEmpty){
    final ride=await Api.get('mobile/rides/${Uri.encodeComponent(rideId)}');
    if(!mounted)return;
    if(ride is Map&&ride['id']==rideId&&['ASSIGNED','ARRIVING','IN_PROGRESS'].contains(ride['status'])){
     if(item['category']=='CHAT'){await Navigator.push(context,MaterialPageRoute(builder:(_)=>RideCommunicationScreen(rideId:rideId,reference:(ride['reference']??'Ride').toString())));}
     else if(mobileRole=='CUSTOMER'){await Navigator.push(context,MaterialPageRoute(builder:(_)=>RideTrackingScreen(rideId:rideId,reference:(ride['reference']??'Ride').toString())));}
    }
   }
   await reload();
  }catch(e){if(mounted)setState(()=>error='Could not open notification: $e');}
 }
 @override Widget build(BuildContext context)=>Scaffold(appBar:AppBar(title:const Text('Notifications'),actions:[IconButton(onPressed:reload,icon:const Icon(Icons.refresh))]),body:ListView(padding:const EdgeInsets.all(16),children:[
  SectionCard(child:SwitchListTile(contentPadding:EdgeInsets.zero,title:const Text('Promotional offers'),subtitle:const Text('Optional marketing messages. Ride, payment and safety updates are separate.'),value:marketing,onChanged:setMarketing)),
  if(loading)const LinearProgressIndicator(),if(error.isNotEmpty)Text(error),
  if(entries.isEmpty&&!loading)const Text('No notifications yet.'),
  for(final item in entries)SectionCard(child:ListTile(onTap:()=>openItem(item),leading:Icon(item['readAt']==null?Icons.notifications_active:Icons.notifications_none,color:blue),title:Text((item['title']??'RideFlow').toString(),style:TextStyle(fontWeight:item['readAt']==null?FontWeight.bold:FontWeight.normal)),subtitle:Text('${item['body']??''}\n${item['category']??''}'),isThreeLine:true,trailing:item['readAt']==null?const Icon(Icons.circle,size:9,color:blue):null))
 ]));
}
class Profile extends StatelessWidget {final bool driver;const Profile({super.key,required this.driver});@override Widget build(BuildContext context)=>ListView(padding:const EdgeInsets.all(20),children:[const Text('Account',style:TextStyle(fontSize:28,fontWeight:FontWeight.w800)),const SizedBox(height:18),SectionCard(child:Column(children:[const CircleAvatar(radius:28,child:Icon(Icons.person)),const SizedBox(height:12),Text(driver?'Demo driver':'Demo customer',style:const TextStyle(fontWeight:FontWeight.w800,fontSize:18)),const SizedBox(height:7),const Text('Authentication and profile editing pending',style:TextStyle(color:Colors.black54,fontSize:12))])),const PushOptIn(),SectionCard(child:ListTile(leading:const Icon(Icons.notifications_outlined),title:const Text('Notification inbox'),subtitle:const Text('Ride, payment and service messages'),onTap:()=>Navigator.push(context,MaterialPageRoute(builder:(_)=>const NotificationInbox())))),for(final item in ['Payment methods','Support','Safety center','Settings'])SectionCard(child:Row(children:[const Icon(Icons.chevron_right,color:blue),const SizedBox(width:12),Text(item)]))]);}

class MobileLogin extends StatefulWidget {const MobileLogin({super.key});@override State<MobileLogin> createState()=>_MobileLoginState();}
class ParcelDeliveryScreen extends StatefulWidget {const ParcelDeliveryScreen({super.key});@override State<ParcelDeliveryScreen> createState()=>_ParcelDeliveryScreenState();}
class _ParcelDeliveryScreenState extends State<ParcelDeliveryScreen>{
 final pickup=TextEditingController(),dropoff=TextEditingController(),recipient=TextEditingController(),phone=TextEditingController(),description=TextEditingController();
 String? cityId;List<dynamic> cities=[],deliveries=[];bool enabled=true,busy=false;String message='';double weight=1;
 @override void initState(){super.initState();load();}
 @override void dispose(){for(final c in [pickup,dropoff,recipient,phone,description]){c.dispose();}super.dispose();}
 Future<void> load()async{try{final a=await Api.get('mobile/parcel/availability');final c=await Api.get('mobile/cities');final d=await Api.get('mobile/parcel/deliveries');if(mounted)setState((){enabled=a['enabled']==true;cities=c as List<dynamic>;cityId ??= cities.isNotEmpty?cities.first['id'] as String:null;deliveries=d as List<dynamic>;});}catch(e){if(mounted)setState(()=>message='Unable to load parcels: $e');}}
 Future<void> submit()async{if(!enabled||cityId==null)return;setState((){busy=true;message='';});try{final r=await Api.post('mobile/parcel/deliveries',{'cityId':cityId,'pickup':pickup.text,'dropoff':dropoff.text,'recipientName':recipient.text,'recipientPhone':phone.text,'description':description.text,'weightKg':weight});if(mounted)setState(()=>message='Request created: ${r['reference']}');await load();}catch(e){if(mounted)setState(()=>message='Request failed: $e');}finally{if(mounted)setState(()=>busy=false);}}
 Future<void> approveFare(String id)async{
  try{
   final fare=await Api.get('mobile/parcel/deliveries/$id/fare');
   if(!mounted)return;
   if(fare['canApprove']!=true){setState(()=>message='Fare expired or unavailable. Ask dispatch to issue a new quote.');return;}
   final amount=((fare['amountPaise'] as num)/100).toStringAsFixed(2);
   final confirmed=await showDialog<bool>(context:context,builder:(ctx)=>AlertDialog(title:const Text('Approve parcel fare'),content:Text('Confirm ₹$amount for this parcel? This quote expires at ${fare['expiresAt']}. Approval does not charge you.'),actions:[TextButton(onPressed:()=>Navigator.pop(ctx,false),child:const Text('Cancel')),FilledButton(onPressed:()=>Navigator.pop(ctx,true),child:const Text('Approve fare'))]));
   if(confirmed!=true)return;
   await Api.post('mobile/parcel/deliveries/$id/fare/approve',{});
   if(mounted){setState(()=>message='Fare approved. You can now pay.');await load();}
  }catch(e){if(mounted)setState(()=>message='Fare approval failed: $e');}
 }
 Future<void> issueCode(String id)async{try{final r=await Api.post('mobile/parcel/deliveries/$id/code',{});if(!mounted)return;showDialog(context:context,builder:(_)=>AlertDialog(title:Text('${r['purpose']} verification'),content:Column(mainAxisSize:MainAxisSize.min,children:[Text('${r['code']}',style:const TextStyle(fontSize:34,fontWeight:FontWeight.bold,letterSpacing:6)),const SizedBox(height:8),const Text('Valid for five minutes. Share only at handover.')]),actions:[TextButton(onPressed:()=>Navigator.pop(context),child:const Text('Close'))]));}catch(e){if(mounted)setState(()=>message='Code error: $e');}}
 @override Widget build(BuildContext context)=>Scaffold(appBar:AppBar(title:const Text('Parcel delivery'),actions:[IconButton(onPressed:load,icon:const Icon(Icons.refresh))]),body:ListView(padding:const EdgeInsets.all(20),children:[Text(enabled?'Parcel booking available':'New parcel bookings are paused',style:const TextStyle(fontWeight:FontWeight.bold)),const SizedBox(height:12),DropdownButtonFormField<String>(value:cityId,items:cities.map<DropdownMenuItem<String>>((c)=>DropdownMenuItem(value:c['id'] as String,child:Text(c['name'] as String))).toList(),onChanged:enabled?(v)=>setState(()=>cityId=v):null,decoration:const InputDecoration(labelText:'City')),for(final pair in <(TextEditingController,String)>[(pickup,'Pickup address'),(dropoff,'Delivery address'),(recipient,'Recipient name'),(phone,'Recipient phone'),(description,'Parcel description')])Padding(padding:const EdgeInsets.only(top:12),child:TextField(controller:pair.$1,enabled:enabled,decoration:InputDecoration(labelText:pair.$2,border:const OutlineInputBorder()))),const SizedBox(height:10),Text('Package weight: ${weight.toStringAsFixed(1)} kg'),Slider(value:weight,min:0.5,max:20,divisions:39,onChanged:enabled?(v)=>setState(()=>weight=v):null),const Text('Pricing is indicative and finalized by dispatch.'),FilledButton(onPressed:enabled&&!busy?submit:null,child:Text(busy?'Submitting…':'Request parcel delivery')),if(message.isNotEmpty)Text(message),const SizedBox(height:24),const Text('Your deliveries',style:TextStyle(fontSize:21,fontWeight:FontWeight.bold)),for(final d in deliveries)SectionCard(child:Column(crossAxisAlignment:CrossAxisAlignment.start,children:[Text('${d['reference']} · ${d['status']}',style:const TextStyle(fontWeight:FontWeight.bold)),Text('${d['pickup']} → ${d['dropoff']}'),if(d['estimatedFarePaise']!=null)Text('Indicative ₹${((d['estimatedFarePaise'] as num)/100).toStringAsFixed(0)}'),if(d['estimatedFarePaise']!=null&&d['fareApprovedAt']==null&&d['status']=='ACCEPTED')FilledButton(onPressed:()=>approveFare(d['id'].toString()),child:const Text('Review and approve fare')),if(d['estimatedFarePaise']!=null&&d['fareApprovedAt']!=null&&d['parcelPaymentStatus']!='COLLECTED')OutlinedButton.icon(onPressed:()=>showDialog(context:context,builder:(_)=>ParcelPaymentDialog(parcelId:d['id'].toString())),icon:const Icon(Icons.payments_outlined),label:const Text('Pay for parcel')),if(['ACCEPTED','PICKED_UP','IN_TRANSIT'].contains(d['status']))OutlinedButton(onPressed:()=>issueCode(d['id'].toString()),child:Text(d['status']=='ACCEPTED'?'Generate pickup code':'Generate delivery code')),if(['ACCEPTED','PICKED_UP','IN_TRANSIT'].contains(d['status']))OutlinedButton.icon(onPressed:()=>Navigator.push(context,MaterialPageRoute(builder:(_)=>ParcelTrackingMap(parcelId:d['id'].toString(),reference:d['reference'].toString()))),icon:const Icon(Icons.map_outlined),label:const Text('Track courier on map'))]))]));
}
class CourierParcelScreen extends StatefulWidget{const CourierParcelScreen({super.key});@override State<CourierParcelScreen> createState()=>_CourierParcelScreenState();}
class _CourierParcelScreenState extends State<CourierParcelScreen>{List<dynamic> deliveries=[];String error='';bool loading=false;
 @override void initState(){super.initState();load();}
 Future<void> load()async{setState(()=>loading=true);try{final d=await Api.get('mobile/parcel/courier/deliveries');if(mounted)setState((){deliveries=d as List<dynamic>;error='';});}catch(e){if(mounted)setState(()=>error='$e');}finally{if(mounted)setState(()=>loading=false);}}
 Future<void> verify(String id,String stage)async{final c=TextEditingController();final code=await showDialog<String>(context:context,builder:(ctx)=>AlertDialog(title:Text(stage=='pickup'?'Pickup verification':'Delivery verification'),content:TextField(controller:c,maxLength:6,keyboardType:TextInputType.number,decoration:const InputDecoration(labelText:'Six-digit handover code')),actions:[TextButton(onPressed:()=>Navigator.pop(ctx),child:const Text('Cancel')),FilledButton(onPressed:()=>Navigator.pop(ctx,c.text),child:const Text('Verify'))]));c.dispose();if(code==null)return;try{final r=await Api.post('mobile/parcel/courier/deliveries/$id/$stage',{'code':code});if(r['verified']!=true)throw Exception('Invalid code');await load();}catch(e){if(mounted)setState(()=>error='Verification failed: $e');}}
 Future<void> uploadProof(String id) async {
  try {
   final photo=await ImagePicker().pickImage(source:ImageSource.camera,imageQuality:75,maxWidth:1280,maxHeight:1280);
   if(photo==null)return;
   final bytes=await photo.readAsBytes();
   if(bytes.length>2*1024*1024)throw Exception('Photo exceeds 2 MB; retake at lower resolution');
   final mime=bytes.length>=8&&bytes[0]==137&&bytes[1]==80&&bytes[2]==78&&bytes[3]==71?'image/png':'image/jpeg';
   await Api.post('mobile/parcel/courier/deliveries/$id/proof',{'mime':mime,'base64':base64Encode(bytes)});
   await load();
  }catch(e){if(mounted)setState(()=>error='Photo upload failed: $e');}
 }
 Future<void> recordCash(String id) async {
  try{await Api.post('mobile/parcel/courier/deliveries/$id/cash-collected',{'method':'CASH'});await load();}
  catch(e){if(mounted)setState(()=>error='Cash recording failed: $e');}
 }
 @override Widget build(BuildContext context)=>ListView(padding:const EdgeInsets.all(20),children:[Row(children:[const Expanded(child:Text('Courier deliveries',style:TextStyle(fontSize:24,fontWeight:FontWeight.bold))),IconButton(onPressed:load,icon:const Icon(Icons.refresh))]),if(loading)const LinearProgressIndicator(),if(error.isNotEmpty)Text(error),for(final d in deliveries)SectionCard(child:Column(crossAxisAlignment:CrossAxisAlignment.start,children:[Text('${d['reference']} · ${d['status']}',style:const TextStyle(fontWeight:FontWeight.bold)),Text('${d['pickup']} → ${d['dropoff']}'),Text('Recipient: ${d['recipientName']}'),if(d['status']=='ACCEPTED')FilledButton(onPressed:()=>verify(d['id'].toString(),'pickup'),child:const Text('Verify parcel pickup')),if(['PICKED_UP','IN_TRANSIT'].contains(d['status']))FilledButton(onPressed:()=>verify(d['id'].toString(),'deliver'),child:const Text('Verify delivery')),if(d['status']=='DELIVERED'&&d['proofPhotoSha256']==null)OutlinedButton.icon(onPressed:()=>uploadProof(d['id'].toString()),icon:const Icon(Icons.camera_alt_outlined),label:const Text('Capture delivery proof')),if(d['proofPhotoSha256']!=null)const Text('Delivery photo submitted'),if(d['status']=='DELIVERED'&&d['parcelPaymentStatus']=='UNPAID'&&d['estimatedFarePaise']!=null)OutlinedButton(onPressed:()=>recordCash(d['id'].toString()),child:const Text('Record cash collected')),if(d['parcelPaymentStatus']=='COLLECTED')const Text('Cash collection recorded (driver-reported)')]))]);}
}
class _MobileLoginState extends State<MobileLogin>{final phone=TextEditingController(text:'+91');final code=TextEditingController();String role='CUSTOMER';String error='';bool requested=false,busy=false;
Future<void> submit()async{setState((){busy=true;error='';});try{if(!requested){final r=await Api.post('mobile/auth/request-otp',{'phone':phone.text,'role':role});setState((){requested=true;error='Local development code: ${r['developmentCode'] ?? 'Check SMS'}';});}else{final r=await Api.post('mobile/auth/verify-otp',{'phone':phone.text,'role':role,'code':code.text});mobileToken=r['accessToken'];mobileRole=role;if(!mounted)return;Navigator.of(context).pushReplacement(MaterialPageRoute(builder:(_)=>const Shell()));}}catch(e){setState(()=>error='$e');}finally{if(mounted)setState(()=>busy=false);}}
@override Widget build(BuildContext context)=>Scaffold(appBar:AppBar(title:const Text('RideFlow sign in')),body:ListView(padding:const EdgeInsets.all(24),children:[const Text('Your ride starts here',style:TextStyle(fontSize:27,fontWeight:FontWeight.bold)),const SizedBox(height:20),DropdownButtonFormField<String>(value:role,items:const [DropdownMenuItem(value:'CUSTOMER',child:Text('Customer')),DropdownMenuItem(value:'DRIVER',child:Text('Driver'))],onChanged:requested?null:(v)=>setState(()=>role=v!)),const SizedBox(height:14),TextField(controller:phone,keyboardType:TextInputType.phone,decoration:const InputDecoration(labelText:'Mobile number (+91...)',border:OutlineInputBorder())),if(requested)...[const SizedBox(height:14),TextField(controller:code,keyboardType:TextInputType.number,decoration:const InputDecoration(labelText:'Six-digit code',border:OutlineInputBorder()))],const SizedBox(height:20),FilledButton(onPressed:busy?null:submit,child:Text(busy?'Please wait…':requested?'Verify and continue':'Request OTP')),if(error.isNotEmpty)Padding(padding:const EdgeInsets.only(top:14),child:Text(error)),const SizedBox(height:20),const Text('Development-only OTP flow. Production SMS delivery and anti-abuse protections are not configured.',style:TextStyle(color:Colors.black54))]));}
}

/// OpenStreetMap tiles require internet access and compliance with tile usage policy.
class RideMap extends StatelessWidget {
 final double latitude,longitude; final String caption;
 const RideMap({super.key,required this.latitude,required this.longitude,required this.caption});
 @override Widget build(BuildContext context)=>Column(crossAxisAlignment:CrossAxisAlignment.start,children:[
  ClipRRect(borderRadius:BorderRadius.circular(18),child:SizedBox(height:220,child:FlutterMap(
   options:MapOptions(initialCenter:LatLng(latitude,longitude),initialZoom:14),
   children:[TileLayer(urlTemplate:'https://tile.openstreetmap.org/{z}/{x}/{y}.png',userAgentPackageName:'com.rideflow.mobile'),
    MarkerLayer(markers:[Marker(point:LatLng(latitude,longitude),width:48,height:48,child:const Icon(Icons.location_pin,color:Colors.blue,size:42))]),
    const RichAttributionWidget(attributions:[TextSourceAttribution('OpenStreetMap contributors')])],
  ))),const SizedBox(height:5),Text(caption,style:const TextStyle(fontSize:11,color:Colors.black54))]);
}

/// Location access is requested only after an explicit user action.
Future<Position> acquireGps() async {
 if(!await Geolocator.isLocationServiceEnabled())throw Exception('Enable device location services');
 var permission=await Geolocator.checkPermission();
 if(permission==LocationPermission.denied)permission=await Geolocator.requestPermission();
 if(permission==LocationPermission.denied||permission==LocationPermission.deniedForever)throw Exception('Location permission required');
 return Geolocator.getCurrentPosition(locationSettings:const LocationSettings(accuracy:LocationAccuracy.high,timeLimit:Duration(seconds:12)));
}

class PickupMapPicker extends StatefulWidget {
 final LatLng? initial; final String title;final String confirmLabel;
 const PickupMapPicker({super.key,this.initial,this.title='Choose pickup point',this.confirmLabel='Confirm pickup'});
 @override State<PickupMapPicker> createState()=>_PickupMapPickerState();
}
class _PickupMapPickerState extends State<PickupMapPicker> {
 late LatLng pin;String notice='';bool locating=false;
 @override void initState(){super.initState();pin=widget.initial??const LatLng(26.9124,75.7873);}
 Future<void> currentLocation()async{setState(()=>locating=true);try{final p=await acquireGps();if(mounted)setState((){pin=LatLng(p.latitude,p.longitude);notice='GPS acquired. Tap map to adjust.';});}catch(e){if(mounted)setState(()=>notice='$e');}finally{if(mounted)setState(()=>locating=false);}}
 @override Widget build(BuildContext context)=>Scaffold(appBar:AppBar(title:Text(widget.title)),body:Column(children:[Expanded(child:FlutterMap(options:MapOptions(initialCenter:pin,initialZoom:15,onTap:(_,point)=>setState(()=>pin=point)),children:[TileLayer(urlTemplate:'https://tile.openstreetmap.org/{z}/{x}/{y}.png',userAgentPackageName:'com.rideflow.mobile'),MarkerLayer(markers:[Marker(point:pin,width:50,height:50,child:const Icon(Icons.location_pin,size:46,color:Colors.blue))]),const RichAttributionWidget(attributions:[TextSourceAttribution('OpenStreetMap contributors')])])),Padding(padding:const EdgeInsets.all(14),child:Column(children:[Text('Pickup: ${pin.latitude.toStringAsFixed(6)}, ${pin.longitude.toStringAsFixed(6)}'),if(notice.isNotEmpty)Text(notice),const SizedBox(height:8),Row(children:[Expanded(child:OutlinedButton.icon(onPressed:locating?null:currentLocation,icon:const Icon(Icons.my_location),label:const Text('Use my GPS'))),const SizedBox(width:8),Expanded(child:FilledButton(onPressed:()=>Navigator.pop(context,pin),child:Text(widget.confirmLabel)))]),const Text('Map coordinates are not a verified street address.',style:TextStyle(fontSize:11))]))]));
}

/// Displays driver and pickup separately; road routes are labeled distinctly from straight-line fallbacks.
class TrackingRouteMap extends StatelessWidget {
 final LatLng driver;final LatLng? pickup;final Map<String,dynamic>? route;
 const TrackingRouteMap({super.key,required this.driver,required this.pickup,required this.route});
 @override Widget build(BuildContext context){
  final coords=route?['coordinates'];
  final points=<LatLng>[];
  if(coords is List){for(final p in coords){if(p is List&&p.length>=2&&p[0] is num&&p[1] is num){points.add(LatLng((p[0] as num).toDouble(),(p[1] as num).toDouble()));}}}
  final markers=<Marker>[Marker(point:driver,width:46,height:46,child:const Icon(Icons.directions_car,color:blue,size:36)),if(pickup!=null)Marker(point:pickup!,width:46,height:46,child:const Icon(Icons.location_pin,color:Colors.deepOrange,size:40))];
  final isRoad=route?['source']=='road';
  return SectionCard(child:Column(crossAxisAlignment:CrossAxisAlignment.start,children:[
   const Text('Driver to pickup',style:TextStyle(fontWeight:FontWeight.w800,fontSize:17)),const SizedBox(height:10),
   ClipRRect(borderRadius:BorderRadius.circular(14),child:SizedBox(height:270,child:FlutterMap(
    options:MapOptions(initialCenter:pickup==null?driver:LatLng((driver.latitude+pickup!.latitude)/2,(driver.longitude+pickup!.longitude)/2),initialZoom:13),
    children:[TileLayer(urlTemplate:'https://tile.openstreetmap.org/{z}/{x}/{y}.png',userAgentPackageName:'com.rideflow.mobile'),if(points.length>=2)PolylineLayer(polylines:[Polyline(points:points,strokeWidth:5,color:isRoad?blue:Colors.orange)]),MarkerLayer(markers:markers),const RichAttributionWidget(attributions:[TextSourceAttribution('OpenStreetMap contributors')])],
   ))),const SizedBox(height:10),
   if(route!=null)...[Text('${route!['distanceKm']} km · ${isRoad?'Estimated arrival: ${route!['etaMinutes']} min':'Straight-line distance (no driving ETA)'}',style:const TextStyle(fontWeight:FontWeight.w700)),const SizedBox(height:4),Text('${route!['disclaimer']}',style:const TextStyle(fontSize:11,color:Colors.black54))]
   else const Text('Waiting for recent driver GPS and pickup coordinates',style:TextStyle(fontSize:12,color:Colors.black54)),
  ]));
 }
}

class FarePreview extends StatelessWidget {final Map<String,dynamic> quote;const FarePreview({super.key,required this.quote});
@override Widget build(BuildContext context){final route=quote['route'];final points=<LatLng>[];if(route is Map&&route['coordinates'] is List){for(final p in route['coordinates']){if(p is List&&p.length>=2&&p[0] is num&&p[1] is num)points.add(LatLng((p[0] as num).toDouble(),(p[1] as num).toDouble()));}}
return Column(crossAxisAlignment:CrossAxisAlignment.start,children:[if(points.length>=2)SizedBox(height:220,child:FlutterMap(options:MapOptions(initialCenter:points[points.length~/2],initialZoom:12),children:[TileLayer(urlTemplate:'https://tile.openstreetmap.org/{z}/{x}/{y}.png',userAgentPackageName:'com.rideflow.mobile'),PolylineLayer(polylines:[Polyline(points:points,color:blue,strokeWidth:5)]),MarkerLayer(markers:[Marker(point:points.first,child:const Icon(Icons.trip_origin,color:Colors.green)),Marker(point:points.last,child:const Icon(Icons.location_on,color:Colors.red))]),const RichAttributionWidget(attributions:[TextSourceAttribution('OpenStreetMap contributors')])])),const SizedBox(height:8),if(quote['available']==true)...[Text('Estimated fare: ₹${((quote['estimatedFarePaise'] as num)/100).toStringAsFixed(0)}',style:const TextStyle(fontWeight:FontWeight.bold,fontSize:18)),Text('${quote['distanceKm']} km · approximately ${quote['estimatedMinutes']} min'),Text('Quote expires: ${quote['expiresAt'] ?? 'unknown'}',style:const TextStyle(fontSize:11)),Text('${quote['disclaimer']}',style:const TextStyle(fontSize:11))]else Text('${quote['reason']}',style:const TextStyle(color:Colors.deepOrange))]);}}

class RidePaymentDialog extends StatefulWidget {
 final String rideId; final bool completed;
 const RidePaymentDialog({super.key,required this.rideId,required this.completed});
 @override State<RidePaymentDialog> createState()=>_RidePaymentDialogState();
}
class _RidePaymentDialogState extends State<RidePaymentDialog> {
 late Future<dynamic> payment; late Future<dynamic> channels; String message=''; bool busy=false;
 @override void initState(){super.initState();refresh();}
 void refresh(){payment=Api.get('mobile/rides/${widget.rideId}/payment');channels=Api.get('mobile/payment-methods');}
 Future<void> choose(String method) async {setState(()=>busy=true);try{await Api.post('mobile/rides/${widget.rideId}/select-payment',{'method':method});setState((){message='$method selected';refresh();});}catch(e){setState(()=>message='Could not select method: $e');}finally{if(mounted)setState(()=>busy=false);}}
 Future<void> openUpi() async {setState(()=>busy=true);try{final result=await Api.post('mobile/rides/${widget.rideId}/upi-intent',{});final uri=Uri.parse(result['uri'] as String);final launched=await launchUrl(uri,mode:LaunchMode.externalApplication);setState(()=>message=launched?'UPI app opened. Payment is still PENDING until verified.':'No compatible UPI app found. Payment remains pending.');}catch(e){setState(()=>message='UPI unavailable: $e');}finally{if(mounted)setState(()=>busy=false);}}
 Future<void> payWithRazorpay() async {setState(()=>busy=true);try{final order=await Api.post('payments/razorpay/orders/${widget.rideId}',{});final outcome=await RazorpayCheckout.open(order);if(mounted)setState((){message=outcome;refresh();});}catch(e){if(mounted)setState(()=>message='Razorpay checkout unavailable: $e');}finally{if(mounted)setState(()=>busy=false);}}
 Future<void> payWithStripe() async {
  setState(()=>busy=true);
  try {
   final result=await Api.post('payments/stripe/intents/${widget.rideId}',{});
   Stripe.publishableKey=result['publishableKey'] as String;
   await Stripe.instance.applySettings();
   await Stripe.instance.initPaymentSheet(paymentSheetParameters:SetupPaymentSheetParameters(
    paymentIntentClientSecret:result['clientSecret'] as String,
    merchantDisplayName:'RideFlow',
    applePay:const PaymentSheetApplePay(merchantCountryCode:'IN'),
    googlePay:const PaymentSheetGooglePay(merchantCountryCode:'IN',testEnv:true),
   ));
   await Stripe.instance.presentPaymentSheet();
   if(mounted)setState(()=>message='Payment submitted. Waiting for verified provider confirmation; refresh status.');
  } catch(e) {if(mounted)setState(()=>message='Stripe payment unavailable or cancelled: $e');}
  finally {if(mounted){setState(()=>busy=false);refresh();}}
 }
 Future<void> receipt() async {try{final r=await Api.get('mobile/rides/${widget.rideId}/receipt');if(mounted)showDialog(context:context,builder:(context)=>AlertDialog(title:Text('Receipt ${r['reference']}'),content:Text('Fare: ₹${((r['amountPaise'] as num)/100).toStringAsFixed(2)}\nMethod: ${r['paymentMethod']}\nStatus: ${r['paymentStatus']}\n${r['notice']}'),actions:[TextButton(onPressed:()=>Navigator.pop(context),child:const Text('Close'))]));}catch(e){setState(()=>message='Receipt unavailable: $e');}}
 @override Widget build(BuildContext context)=>AlertDialog(title:const Text('Ride payment'),content:SizedBox(width:340,child:FutureBuilder<dynamic>(future:payment,builder:(context,s){if(s.hasError)return Text('Payment unavailable: ${s.error}');if(!s.hasData)return const CircularProgressIndicator();final p=s.data as Map<String,dynamic>?;if(p==null)return const Text('No payment record');return Column(mainAxisSize:MainAxisSize.min,crossAxisAlignment:CrossAxisAlignment.start,children:[Text('₹${((p['amountPaise'] as num)/100).toStringAsFixed(2)}',style:const TextStyle(fontSize:24,fontWeight:FontWeight.bold)),Text('Method: ${p['method']} • Status: ${p['status']}'),const SizedBox(height:12),if(p['status']=='PENDING')...[
 FutureBuilder<dynamic>(future:channels,builder:(context,channelSnapshot){if(!channelSnapshot.hasData)return const Text('Loading available payment methods…');final enabled=((channelSnapshot.data as Map<String,dynamic>)['methods'] as List).where((m)=>m['enabled']==true).map((m)=>m['method'] as String).toSet();return Wrap(spacing:8,children:[if(enabled.contains('COD'))OutlinedButton(onPressed:busy?null:()=>choose('CASH'),child:const Text('COD (no tips/coupons)')),if(enabled.contains('UPI'))OutlinedButton(onPressed:busy?null:()=>choose('UPI'),child:const Text('UPI')),if(enabled.contains('ONLINE'))OutlinedButton(onPressed:busy?null:()=>choose('ONLINE'),child:const Text('Card / Apple Pay / Google Pay'))]);}),
 if(p['method']=='UPI')FilledButton(onPressed:busy?null:openUpi,child:const Text('Open UPI app')),
 if(p['method']=='UPI')FilledButton(onPressed:busy?null:payWithRazorpay,child:const Text('Pay with Razorpay Checkout')),
 if(p['method']=='ONLINE')FilledButton(onPressed:busy?null:payWithStripe,child:const Text('Pay securely with Stripe')),
 const Text('COD: pay the driver on delivery; coupons and tips are unavailable. Online payments remain pending until verified.',style:TextStyle(fontSize:12,color:Colors.black54))],
 if(widget.completed)TextButton(onPressed:receipt,child:const Text('View receipt')),
 if(message.isNotEmpty)Text(message)]); })),actions:[TextButton(onPressed:()=>Navigator.pop(context),child:const Text('Close'))]);
}


// Customer-only foreground tracking. No background GPS collection or route history.
// Chat and direct-dial calling are available only while an assigned trip is active.
class RideCommunicationScreen extends StatefulWidget {
 final String rideId,reference;
 const RideCommunicationScreen({super.key,required this.rideId,required this.reference});
 @override State<RideCommunicationScreen> createState()=>_RideCommunicationScreenState();
}
class _RideCommunicationScreenState extends State<RideCommunicationScreen> {
 final input=TextEditingController();
 List<dynamic> messages=[];
 Timer? poll;
 Timer? typingTimer;
 IO.Socket? chatSocket;
 int socketGeneration=0;
 bool chatConnected=false,loading=false,otherTyping=false;
 int unread=0;
 bool busy=false,active=true;
 String notice='';
 String get endpoint=>'mobile/rides/${widget.rideId}/communication';
 @override void initState(){super.initState();input.addListener(()=>changedMessage(input.text));load();connectChat();poll=Timer.periodic(const Duration(seconds:15),(_){if(!chatConnected)load();});}
 void connectChat(){
  final generation=++socketGeneration;
  try{
   final origin=apiBase.replaceFirst(RegExp(r'/api/?$'),'');
   final socket=IO.io('$origin/live',IO.OptionBuilder().setTransports(['websocket']).disableAutoConnect().setAuth({'token':mobileToken}).enableReconnection().build());
   chatSocket=socket;
   socket.onConnect((_){if(!mounted||generation!=socketGeneration)return;setState(()=>chatConnected=true);load();});
   socket.onDisconnect((_){if(!mounted||generation!=socketGeneration)return;setState(()=>chatConnected=false);});
   socket.on('ride.chat.typing',(data){
    if(!mounted||generation!=socketGeneration||data is! Map||data['rideId']!=widget.rideId||data['role']==mobileRole)return;
    setState(()=>otherTyping=data['typing']==true);
   });
   socket.on('ride.chat.read',(data){
    if(!mounted||generation!=socketGeneration||data is! Map||data['rideId']!=widget.rideId||data['readerRole']==mobileRole)return;
    setState((){messages=messages.map((m){if(m is Map&&m['role']==mobileRole)return {...m,'readAt':DateTime.now().toUtc().toIso8601String()};return m;}).toList();});
   });
   socket.on('ride.chat.message',(data){
    if(!mounted||generation!=socketGeneration||data is! Map||data['rideId']!=widget.rideId)return;
    final id=data['id'];if(id is! String)return;
    setState((){if(!messages.any((m)=>m['id']==id)){
     messages=[...messages,data];
     if(data['role']!=mobileRole)unread++;
    }});
    markRead();
   });
   socket.connect();
  }catch(_){if(mounted)setState(()=>chatConnected=false);}
 }
 Future<void> markRead()async{
  try{await Api.post('$endpoint/read',{});if(mounted)setState(()=>unread=0);}catch(_){}
 }
 void changedMessage(String value){
  if(!chatConnected)return;
  chatSocket?.emit('ride.chat.typing',{'rideId':widget.rideId,'typing':value.trim().isNotEmpty});
  typingTimer?.cancel();
  typingTimer=Timer(const Duration(seconds:2),(){
   chatSocket?.emit('ride.chat.typing',{'rideId':widget.rideId,'typing':false});
  });
 }
 @override void dispose(){socketGeneration++;poll?.cancel();typingTimer?.cancel();chatSocket?.disconnect();chatSocket?.dispose();input.dispose();super.dispose();}
 Future<void> load()async{
  if(!active||loading)return;loading=true;
  try{final result=await Api.get('$endpoint/sync');if(mounted){setState((){messages=(result['messages'] as List);unread=(result['unread'] as num).toInt();notice='';});await markRead();}}
  catch(_){if(mounted)setState(()=>notice='Connection unavailable. Messages will refresh when connected.');}
  finally{loading=false;}
 }
 Future<void> send()async{
  final text=input.text.trim();if(text.isEmpty||busy||!active)return;
  setState(()=>busy=true);
  try{await Api.post('$endpoint/messages',{'text':text});input.clear();await load();}
  catch(e){if(mounted)setState(()=>notice='Message not sent: $e');}
  finally{if(mounted)setState(()=>busy=false);}
 }
 Future<void> call()async{
  try{
   final data=await Api.get('$endpoint/call');
   if(!mounted)return;
   final accepted=await showDialog<bool>(context:context,builder:(context)=>AlertDialog(
    title:Text('Call ${data['name']}?'),content:const Text('Only a verified temporary relay number may be dialed. Carrier call charges may apply.'),
    actions:[TextButton(onPressed:()=>Navigator.pop(context,false),child:const Text('Cancel')),
     FilledButton(onPressed:()=>Navigator.pop(context,true),child:const Text('Open dialer'))]));
   if(accepted==true){if(data['masked']!=true)throw Exception('A verified masked calling relay is required');final phone=(data['relayNumber']??'').toString();
    if(!RegExp(r'^\+?[0-9]{8,15}$').hasMatch(phone))throw Exception('Invalid phone number');
    final uri=Uri(scheme:'tel',path:phone);
    if(!await launchUrl(uri,mode:LaunchMode.externalApplication))throw Exception('Phone dialer unavailable');
   }
  }catch(e){if(mounted)setState(()=>notice='Call unavailable: $e');}
 }
 @override Widget build(BuildContext context)=>Scaffold(appBar:AppBar(title:Text('Trip chat · ${widget.reference}'),actions:[IconButton(onPressed:active?call:null,tooltip:'Call trip participant',icon:const Icon(Icons.call))]),
 body:Column(children:[Padding(padding:const EdgeInsets.all(8),child:Text(otherTyping?'Other participant is typing…':chatConnected?'Live chat connected · $unread unread':'Reconnecting · checking messages every 15 seconds',style:const TextStyle(fontSize:12))),if(notice.isNotEmpty)Padding(padding:const EdgeInsets.all(12),child:Text(notice)),
 Expanded(child:ListView.builder(padding:const EdgeInsets.all(12),itemCount:messages.length,itemBuilder:(context,index){
  final m=messages[index];final own=m['role']==mobileRole;
  return Align(alignment:own?Alignment.centerRight:Alignment.centerLeft,child:Container(margin:const EdgeInsets.symmetric(vertical:4),padding:const EdgeInsets.all(12),
   decoration:BoxDecoration(color:own?const Color(0xFFE0E7FF):Colors.white,borderRadius:BorderRadius.circular(12)),
   child:Column(crossAxisAlignment:CrossAxisAlignment.start,children:[Text(own?'You':m['role'].toString(),style:const TextStyle(fontWeight:FontWeight.bold,fontSize:11)),Text(m['text'].toString()),if(own)Text(m['readAt']==null?'Sent':'Read',style:const TextStyle(fontSize:10,color:Colors.black54))])));
 })),SafeArea(child:Padding(padding:const EdgeInsets.all(10),child:Row(children:[Expanded(child:TextField(controller:input,enabled:active,maxLength:1000,maxLines:2,minLines:1,decoration:const InputDecoration(hintText:'Message your trip partner'))),
 IconButton(onPressed:busy||!active?null:send,icon:const Icon(Icons.send))])))]));
}
class RideTrackingScreen extends StatefulWidget {
 final String rideId,reference;
 const RideTrackingScreen({super.key,required this.rideId,required this.reference});
 @override State<RideTrackingScreen> createState()=>_RideTrackingScreenState();
}
class _RideTrackingScreenState extends State<RideTrackingScreen> with SingleTickerProviderStateMixin, WidgetsBindingObserver {
 Timer? timer;
 Timer? freshnessTimer;
 IO.Socket? liveSocket;
 bool socketConnected=false;
 final MapController mapController=MapController();
 late final AnimationController motion;
 LatLng? driver,pickup,dropoff,displayedDriver,fromDriver,toDriver;
 String status='Loading',message='';
 DateTime? updatedAt;
 bool busy=false,followDriver=true,mapReady=false;
 double headingRadians=0,fromHeading=0,toHeading=0;
 String locationSource='gps';
 bool trackingForeground=true;
 int consecutiveFailures=0;
 DateTime? lastSuccessfulFix;
 DateTime? lastAcceptedObservation;
 int trackingGeneration=0;
 int liveSession=0;
 int liveFixCount=0,liveRejectedCount=0,httpCheckCount=0;
 DateTime? lastLiveReceivedAt;
 DateTime? lastHeadingObservation;
 LatLng? lastHeadingFix;
 static const maxFixAge=Duration(seconds:30);
 Duration get retryInterval=>socketConnected?const Duration(seconds:20):Duration(seconds:math.min(30,5*(1<<math.min(consecutiveFailures,3))));
 void scheduleTrackingPoll(){
  timer?.cancel();
  if(!trackingForeground||!mounted)return;
  timer=Timer(retryInterval,(){refresh();});
 }
 double bearing(LatLng a,LatLng b){
  final lat1=a.latitude*math.pi/180,lat2=b.latitude*math.pi/180;
  final deltaLon=(b.longitude-a.longitude)*math.pi/180;
  return math.atan2(math.sin(deltaLon)*math.cos(lat2),math.cos(lat1)*math.sin(lat2)-math.sin(lat1)*math.cos(lat2)*math.cos(deltaLon));
 }
 double shortestTurn(double from,double to)=>((to-from+3*math.pi)%(2*math.pi))-math.pi;
 @override void didChangeAppLifecycleState(AppLifecycleState state){
  trackingForeground=state==AppLifecycleState.resumed;
  if(!trackingForeground){trackingGeneration++;timer?.cancel();motion.stop();freshnessTimer?.cancel();disconnectLive();}
  else {connectLive();startFreshnessWatch();refresh();}
 }
 @override void initState(){
  WidgetsBinding.instance.addObserver(this);
  super.initState();
  motion=AnimationController(vsync:this,duration:const Duration(milliseconds:1800))
   ..addListener((){if(!mounted||fromDriver==null||toDriver==null)return;
    final t=Curves.easeInOutCubic.transform(motion.value);
    setState((){displayedDriver=LatLng(fromDriver!.latitude+(toDriver!.latitude-fromDriver!.latitude)*t,fromDriver!.longitude+(toDriver!.longitude-fromDriver!.longitude)*t);headingRadians=fromHeading+shortestTurn(fromHeading,toHeading)*t;});
    if(followDriver&&mapReady&&displayedDriver!=null)mapController.move(displayedDriver!,mapController.camera.zoom);
   });
  connectLive();
  startFreshnessWatch();
  refresh();
 }
 void disconnectLive(){
  liveSession++;
  socketConnected=false;
  liveSocket?.dispose();
  liveSocket=null;
 }
 void connectLive(){
  disconnectLive();
  if(!trackingForeground||mobileToken.isEmpty)return;
  final origin=Uri.parse(apiBase).origin;
  final socket=IO.io('$origin/live',IO.OptionBuilder()
   .setTransports(['websocket'])
   .disableAutoConnect()
   .setAuth({'token':mobileToken})
   .enableReconnection()
   .setReconnectionDelay(1000)
   .setReconnectionDelayMax(10000)
   .build());
  liveSocket=socket;
  final session=liveSession;
  bool current()=>mounted&&trackingForeground&&session==liveSession&&identical(liveSocket,socket);
  socket.onConnect((_){if(!current())return;setState(()=>socketConnected=true);scheduleTrackingPoll();refresh();});
  socket.onDisconnect((_){if(!current())return;setState(()=>socketConnected=false);scheduleTrackingPoll();});
  socket.onConnectError((_){if(!current())return;setState(()=>socketConnected=false);scheduleTrackingPoll();});
  socket.on('ride.location',(payload){
   if(!current()||payload is! Map||payload['rideId']!=widget.rideId)return;
   final observed=DateTime.tryParse((payload['observedAt']??'').toString())?.toUtc();
   final now=DateTime.now().toUtc();
   final accuracy=payload['accuracyMeters'];
   final next=point(payload);
   if(next==null||observed==null||observed.isAfter(now.add(const Duration(seconds:5)))||
      now.difference(observed)>maxFixAge||
      (accuracy is num&&accuracy>200)||
      (lastAcceptedObservation!=null&&!observed.isAfter(lastAcceptedObservation!))){liveRejectedCount++;return;}
   // A strictly increasing observation timestamp is the deduplication key
   // across reconnects, live events, and the HTTP fallback.
   lastAcceptedObservation=observed;
   liveFixCount++;lastLiveReceivedAt=now;
   lastSuccessfulFix=observed;
   setState((){updatedAt=observed;locationSource='gps';message='';});
   applyDriver(next);
  });
  socket.on('ride.updated',(payload){
   if(!current()||payload is! Map||payload['id']!=widget.rideId)return;
   final nextStatus=(payload['status']??'').toString();
   if(nextStatus.isEmpty)return;
   setState(()=>status=nextStatus);
   if(!['ASSIGNED','ARRIVING','IN_PROGRESS'].contains(nextStatus)){
    trackingGeneration++;trackingForeground=false;timer?.cancel();freshnessTimer?.cancel();
    applyDriver(null);disconnectLive();
   }else{refresh();}
  });
  socket.connect();
 }
 void startFreshnessWatch(){
  freshnessTimer?.cancel();
  freshnessTimer=Timer.periodic(const Duration(seconds:2),(_){
   if(!mounted||!trackingForeground||displayedDriver==null)return;
   if(lastSuccessfulFix==null||DateTime.now().toUtc().difference(lastSuccessfulFix!)>maxFixAge){
    applyDriver(null);
    setState(()=>message='Driver GPS temporarily unavailable.');
   }
  });
 }
 @override void dispose(){trackingGeneration++;WidgetsBinding.instance.removeObserver(this);timer?.cancel();freshnessTimer?.cancel();disconnectLive();motion.dispose();mapController.dispose();super.dispose();}
 LatLng? point(dynamic value)=>value is Map && value['latitude'] is num && value['longitude'] is num?LatLng((value['latitude'] as num).toDouble(),(value['longitude'] as num).toDouble()):null;
 void applyDriver(LatLng? next){
  if(next==null){motion.stop();lastHeadingFix=null;lastHeadingObservation=null;setState((){driver=null;displayedDriver=null;fromDriver=null;toDriver=null;});return;}
  final prior=displayedDriver;
  driver=next;
  if(prior==null){motion.stop();lastHeadingFix=next;setState(()=>displayedDriver=next);return;}
  final meters=const Distance().as(LengthUnit.Meter,prior,next);
  // Ignore sub-5m GPS jitter. Teleports (>1km per report) snap rather than animate across a city.
  if(meters<5)return;
  if(meters>1000){motion.stop();lastHeadingFix=next;setState(()=>displayedDriver=next);if(followDriver&&mapReady)mapController.move(next,mapController.camera.zoom);return;}
  // Heading comes from two verified GPS positions; no invented road snapping.
  // Use the previous *accepted fix* for heading rather than the moving
  // animation marker. Rapid incoming updates otherwise exaggerate turns.
  final headingOrigin=lastHeadingFix??prior;
  final headingDistance=const Distance().as(LengthUnit.Meter,headingOrigin,next);
  fromHeading=headingRadians;
  if(headingDistance>=12) {
   final proposed=bearing(headingOrigin,next);
   // Damp sharp heading changes, but still allow a real U-turn over updates.
   final turn=shortestTurn(headingRadians,proposed);
   toHeading=headingRadians+turn.clamp(-math.pi/2,math.pi/2);
   lastHeadingFix=next;
   lastHeadingObservation=lastAcceptedObservation;
  }else{toHeading=headingRadians;}
  fromDriver=prior;toDriver=next;
  // New GPS targets start from the current animated marker, so updates do not
  // teleport back to the previous destination when they arrive rapidly.
  final durationMs=(meters*35).round().clamp(350,1800);
  motion.duration=Duration(milliseconds:durationMs);
  motion.forward(from:0);
 }
 Future<void> refresh() async {
  httpCheckCount++;
  if(busy||!trackingForeground)return;
  busy=true;
  final generation=trackingGeneration;
  try {
   final data=await Api.get('mobile/rides/${widget.rideId}/tracking') as Map<String,dynamic>;
   if(!mounted||!trackingForeground||generation!=trackingGeneration)return;
   var next=point(data['location']);
   final observed=data['location'] is Map?DateTime.tryParse((data['location']['updatedAt']??'').toString())?.toUtc():null;
   final now=DateTime.now().toUtc();
   // Never extrapolate through a tunnel or outage: only accept fresh, ordered observations.
   final olderThanLive=observed!=null&&lastAcceptedObservation!=null&&!observed.isAfter(lastAcceptedObservation!);
   if(next!=null&&(observed==null||observed.isAfter(now.add(const Duration(seconds:5)))||now.difference(observed)>maxFixAge||olderThanLive)){
    next=null;
    if(observed!=null&&lastAcceptedObservation!=null&&!observed.isAfter(lastAcceptedObservation!)){
     // A repeated observation is not a new GPS fix; preserve the last displayed marker only while fresh.
     next=lastSuccessfulFix!=null&&now.difference(lastSuccessfulFix!)<=maxFixAge?driver:null;
    }
   }
   if(next!=null&&observed!=null&&(lastAcceptedObservation==null||observed.isAfter(lastAcceptedObservation!))){lastAcceptedObservation=observed;lastSuccessfulFix=observed;}
   setState((){status=(data['status']??'Unknown').toString();pickup=point(data['pickup']);dropoff=point(data['dropoff']);locationSource=(data['locationSource']??'gps').toString();updatedAt=data['location'] is Map?DateTime.tryParse((data['location']['updatedAt']??'').toString()):null;message=next==null?(data['reason']??'Waiting for GPS').toString():'';});
   consecutiveFailures=0;
   if(next==null && !olderThanLive && (lastSuccessfulFix==null||now.difference(lastSuccessfulFix!)>maxFixAge)){lastSuccessfulFix=null;}
   applyDriver(next);
   if(data['active']!=true){trackingGeneration++;trackingForeground=false;timer?.cancel();freshnessTimer?.cancel();disconnectLive();}
  } catch(e){
   consecutiveFailures=math.min(consecutiveFailures+1,3);
   // Never continue to display a driver fix indefinitely during a network outage.
   if(mounted&&trackingForeground&&generation==trackingGeneration){
    if(lastSuccessfulFix==null||DateTime.now().difference(lastSuccessfulFix!)>maxFixAge){
     motion.stop();setState((){driver=null;displayedDriver=null;fromDriver=null;toDriver=null;});
    }
    setState(()=>message='Connection interrupted. Retrying tracking shortly.');
   }
  } finally {busy=false;if(mounted&&trackingForeground&&generation==trackingGeneration)scheduleTrackingPoll();}
 }
 @override Widget build(BuildContext context)=>Scaffold(appBar:AppBar(title:Text('Track ${widget.reference}'),actions:[IconButton(onPressed:()=>Navigator.push(context,MaterialPageRoute(builder:(_)=>RideCommunicationScreen(rideId:widget.rideId,reference:widget.reference))),tooltip:'Chat or call driver',icon:const Icon(Icons.chat_bubble_outline)),IconButton(onPressed:refresh,icon:const Icon(Icons.refresh))]),body:Column(children:[Padding(padding:const EdgeInsets.all(16),child:Column(crossAxisAlignment:CrossAxisAlignment.start,children:[Text('Ride status: $status',style:const TextStyle(fontWeight:FontWeight.bold,fontSize:18)),Text(!trackingForeground?'Tracking paused':lastSuccessfulFix==null||DateTime.now().toUtc().difference(lastSuccessfulFix!)>maxFixAge?'Driver location unavailable':socketConnected?'Live GPS connected':'HTTP fallback active',style:const TextStyle(fontSize:12)),Text('Tracking diagnostics: $liveFixCount live · $liveRejectedCount rejected · $httpCheckCount HTTP checks',style:const TextStyle(fontSize:11)),if(updatedAt!=null)Text('Driver GPS: ${updatedAt!.toLocal()} · ${locationSource=='road'?'Road matched':'Raw GPS'}'),if(message.isNotEmpty)Text(message),const Text('Live GPS events when connected; HTTP fallback and periodic safety checks. Road matching is optional. GPS is hidden when stale; no tunnel position is invented.',style:TextStyle(fontSize:12))])),Expanded(child:displayedDriver==null?const Center(child:Icon(Icons.location_off,size:65,color:Colors.black26)):Stack(children:[FlutterMap(mapController:mapController,options:MapOptions(initialCenter:displayedDriver!,initialZoom:15,onMapReady:(){mapReady=true;},onPositionChanged:(_,hasGesture){if(hasGesture&&followDriver)setState(()=>followDriver=false);}),children:[TileLayer(urlTemplate:'https://tile.openstreetmap.org/{z}/{x}/{y}.png',userAgentPackageName:'com.rideflow.mobile'),MarkerLayer(markers:[Marker(point:displayedDriver!,width:60,height:60,child:Transform.rotate(angle:headingRadians,child:const Icon(Icons.navigation,color:blue,size:42))),if(pickup!=null)Marker(point:pickup!,child:const Icon(Icons.trip_origin,color:Colors.green)),if(dropoff!=null)Marker(point:dropoff!,child:const Icon(Icons.location_on,color:Colors.red))])]),Positioned(right:12,bottom:20,child:FloatingActionButton.small(heroTag:'ride-follow',tooltip:followDriver?'Following driver':'Recenter on driver',onPressed:(){setState(()=>followDriver=true);if(displayedDriver!=null&&mapReady)mapController.move(displayedDriver!,mapController.camera.zoom);},child:Icon(followDriver?Icons.gps_fixed:Icons.my_location)))]) )]));
}

// Customer-only tracking: backend authorizes parcel ownership and filters stale GPS.
class ParcelTrackingMap extends StatefulWidget {
  final String parcelId, reference;
  const ParcelTrackingMap({super.key,required this.parcelId,required this.reference});
  @override State<ParcelTrackingMap> createState()=>_ParcelTrackingMapState();
}
class _ParcelTrackingMapState extends State<ParcelTrackingMap> {
  Timer? timer;
  LatLng? courier;
  String status='Loading', message='';
  DateTime? reportedAt;
  bool pending=false;
  @override void initState(){super.initState();refresh();timer=Timer.periodic(const Duration(seconds:15),(_)=>refresh());}
  @override void dispose(){timer?.cancel();super.dispose();}
  Future<void> refresh() async {
    if(pending)return;
    pending=true;
    try {
      final data=await Api.get('mobile/parcel/deliveries/${widget.parcelId}/tracking') as Map<String,dynamic>;
      final location=data['location'];
      if(!mounted)return;
      setState((){
        status=(data['status']??'Unknown').toString();
        courier=location is Map && location['latitude'] is num && location['longitude'] is num
          ? LatLng((location['latitude'] as num).toDouble(),(location['longitude'] as num).toDouble()):null;
        reportedAt=location is Map?DateTime.tryParse((location['updatedAt']??'').toString()):null;
        message=courier==null?(data['reason']??'Courier location is not currently available').toString():'';
      });
      if(['DELIVERED','CANCELLED'].contains(status)){timer?.cancel();}
    } catch(e){if(mounted)setState(()=>message='Tracking unavailable: $e');}
    finally{pending=false;}
  }
  @override Widget build(BuildContext context)=>Scaffold(
    appBar:AppBar(title:Text('Parcel ${widget.reference}'),actions:[IconButton(onPressed:refresh,icon:const Icon(Icons.refresh))]),
    body:Column(children:[
      Padding(padding:const EdgeInsets.all(16),child:Column(crossAxisAlignment:CrossAxisAlignment.start,children:[
        Text('Delivery status: $status',style:const TextStyle(fontSize:19,fontWeight:FontWeight.bold)),
        if(reportedAt!=null)Text('Courier GPS reported: ${reportedAt!.toLocal()}'),
        if(message.isNotEmpty)Text(message,style:const TextStyle(color:Colors.black54)),
        const Text('Updates approximately every 15 seconds while this screen is open.',style:TextStyle(fontSize:12)),
      ])),
      Expanded(child:courier==null?const Center(child:Icon(Icons.location_off_outlined,size:70,color:Colors.black26)):
        FlutterMap(options:MapOptions(initialCenter:courier!,initialZoom:15),children:[
          TileLayer(urlTemplate:'https://tile.openstreetmap.org/{z}/{x}/{y}.png',userAgentPackageName:'com.rideflow.mobile'),
          MarkerLayer(markers:[Marker(point:courier!,width:70,height:70,child:const Column(children:[Icon(Icons.delivery_dining,color:blue,size:38),Text('Courier',style:TextStyle(fontSize:11,fontWeight:FontWeight.bold))]))]),
        ])),
    ]),
  );
}


// Parcel checkout is separate from passenger ride checkout.
// Only signed provider webhooks can mark a parcel payment as recorded.
class ParcelPaymentDialog extends StatefulWidget {
  const ParcelPaymentDialog({super.key, required this.parcelId});
  final String parcelId;
  @override State<ParcelPaymentDialog> createState() => _ParcelPaymentDialogState();
}
class _ParcelPaymentDialogState extends State<ParcelPaymentDialog> {
  late Future<dynamic> status;
  bool busy = false;
  String message = '';
  @override void initState() { super.initState(); refresh(); }
  void refresh() { setState(() => status = Api.get('parcel-payments/${widget.parcelId}/status')); }
  Future<void> stripeCheckout() async {
    setState(() => busy = true);
    try {
      final data = await Api.post('parcel-payments/${widget.parcelId}/stripe', {});
      Stripe.publishableKey = data['publishableKey'] as String;
      await Stripe.instance.applySettings();
      await Stripe.instance.initPaymentSheet(paymentSheetParameters: SetupPaymentSheetParameters(
        paymentIntentClientSecret: data['clientSecret'] as String,
        merchantDisplayName: 'RideFlow Parcel',
        // Wallets require eligible accounts, platform entitlements and device testing.
        applePay: const PaymentSheetApplePay(merchantCountryCode: 'IN'),
        googlePay: const PaymentSheetGooglePay(merchantCountryCode: 'IN', testEnv: true),
      ));
      await Stripe.instance.presentPaymentSheet();
      message = 'Checkout submitted. Awaiting verified webhook confirmation.';
    } catch (e) { message = 'Stripe checkout unavailable or cancelled: $e'; }
    finally { if (mounted) { setState(() => busy = false); refresh(); } }
  }
  Future<void> razorpayCheckout() async {
    setState(() => busy = true);
    try {
      final data = await Api.post('parcel-payments/${widget.parcelId}/razorpay', {});
      message = await RazorpayCheckout.open(data);
    } catch (e) { message = 'Razorpay checkout unavailable or cancelled: $e'; }
    finally { if (mounted) { setState(() => busy = false); refresh(); } }
  }
  @override Widget build(BuildContext context) => AlertDialog(
    title: const Text('Parcel payment'),
    content: SizedBox(width: 340, child: FutureBuilder<dynamic>(future: status, builder: (context, snapshot) {
      if (snapshot.hasError) return Text('Unable to load payment: ${snapshot.error}');
      if (!snapshot.hasData) return const CircularProgressIndicator();
      final p = snapshot.data as Map<String, dynamic>;
      return Column(mainAxisSize: MainAxisSize.min, crossAxisAlignment: CrossAxisAlignment.start, children: [
        Text('Status: ${p['status']}', style: const TextStyle(fontWeight: FontWeight.bold)),
        if (p['amountPaise'] is num) Text('Amount: ₹${((p['amountPaise'] as num)/100).toStringAsFixed(2)}'),
        if (p['provider'] != null) Text('Gateway: ${p['provider']}'),
        const SizedBox(height: 12),
        if (p['status'] == 'UNPAID' || p['status'] == 'PENDING') ...[
          FilledButton(onPressed: busy ? null : stripeCheckout, child: const Text('Stripe / supported wallets')),
          OutlinedButton(onPressed: busy ? null : razorpayCheckout, child: const Text('Razorpay / UPI')),
        ],
        const Text('Only a verified gateway webhook confirms payment.', style: TextStyle(fontSize: 12)),
        if (message.isNotEmpty) Text(message),
      ]);
    })),
    actions: [TextButton(onPressed: busy ? null : refresh, child: const Text('Refresh')), TextButton(onPressed: () => Navigator.pop(context), child: const Text('Close'))],
  );
}

// Phase 48: approval is separate from charging. Legacy checkout remains blocked for grouped rides.
class PoolingFareScreen extends StatefulWidget {
 final String groupId;
 const PoolingFareScreen({super.key,required this.groupId});
 @override State<PoolingFareScreen> createState()=>_PoolingFareScreenState();
}
class _PoolingFareScreenState extends State<PoolingFareScreen> {
 Map<String,dynamic>? offer; String notice=''; bool busy=false;
 @override void initState(){super.initState();load();}
 Future<void> load() async {try{final data=await Api.get('mobile/pooling/groups/${widget.groupId}/my-fare');if(mounted)setState(()=>offer=Map<String,dynamic>.from(data));}catch(e){if(mounted)setState(()=>notice='Fare unavailable: $e');}}
 Future<void> approve() async {
  final amount=offer?['offeredFarePaise'];if(amount is! num)return;
  final confirmed=await showDialog<bool>(context:context,builder:(ctx)=>AlertDialog(title:const Text('Approve shared-ride fare?'),content:Text('Your offered fare is ₹${(amount/100).toStringAsFixed(2)}. Approval does not charge you. Checkout is not yet available for pooled rides.'),actions:[TextButton(onPressed:()=>Navigator.pop(ctx,false),child:const Text('Cancel')),FilledButton(onPressed:()=>Navigator.pop(ctx,true),child:const Text('Approve fare'))]));
  if(confirmed!=true||!mounted)return;setState(()=>busy=true);
  try{await Api.post('mobile/pooling/groups/${widget.groupId}/approve-fare',{});await load();if(mounted)setState(()=>notice='Fare approved. Payment remains unavailable until secure pooled settlement is enabled.');}
  catch(e){if(mounted)setState(()=>notice='Approval failed: $e');}
  finally{if(mounted)setState(()=>busy=false);}
 }
 @override Widget build(BuildContext context){final amount=offer?['offeredFarePaise'];final expiry=DateTime.tryParse(offer?['expiresAt']?.toString()??'');final valid=expiry!=null&&expiry.isAfter(DateTime.now());final approved=offer?['approvedAt']!=null;return Scaffold(appBar:AppBar(title:const Text('Shared-ride fare')),body:ListView(padding:const EdgeInsets.all(20),children:[if(offer==null)const Text('Loading fare offer…')else SectionCard(child:Column(crossAxisAlignment:CrossAxisAlignment.start,children:[Text(amount is num?'Offered: ₹${(amount/100).toStringAsFixed(2)}':'Awaiting dispatcher fare offer',style:const TextStyle(fontSize:22,fontWeight:FontWeight.bold)),if(offer?['originalFarePaise'] is num)Text('Original: ₹${((offer!['originalFarePaise'] as num)/100).toStringAsFixed(2)}'),if(expiry!=null)Text('Offer expires: ${expiry.toLocal()}'),Text(approved?'Approved':'Not approved'),const SizedBox(height:12),FilledButton(onPressed:busy||approved||!valid||amount is! num?null:approve,child:Text(busy?'Approving…':'Approve offered fare')),const SizedBox(height:10),const Text('Approval is not a payment. Shared-ride checkout is disabled pending payment-record integration.',style:TextStyle(fontSize:12))])),if(notice.isNotEmpty)Text(notice),OutlinedButton(onPressed:load,child:const Text('Refresh'))]));}
}

// Phase 59: these screens never initiate payments or alter checkout amounts.
class CouponPreviewScreen extends StatefulWidget {
  final String rideId;
  const CouponPreviewScreen({super.key,required this.rideId});
  @override State<CouponPreviewScreen> createState()=>_CouponPreviewScreenState();
}
class _CouponPreviewScreenState extends State<CouponPreviewScreen> {
  final code=TextEditingController(); Map<String,dynamic>? preview; bool busy=false; String notice=''; bool applied=false;
  @override void dispose(){code.dispose();super.dispose();}
  Future<void> check() async {
    setState((){busy=true;preview=null;applied=false;notice='';});
    try {final result=await Api.post('mobile/rides/${widget.rideId}/coupon-preview',{'code':code.text.trim()});if(mounted)setState(()=>preview=Map<String,dynamic>.from(result));}
    catch(e){if(mounted)setState(()=>notice='Coupon preview unavailable: $e');}
    finally{if(mounted)setState(()=>busy=false);}
  }
  Future<void> apply() async {
    if(preview==null||applied||busy)return;
    final confirmed=await showDialog<bool>(context:context,builder:(ctx)=>AlertDialog(title:const Text('Apply coupon?'),content:Text('Update the pending online payment to ${rupees(preview!['quotedPaise'])}? No payment will be charged now. This is unavailable once checkout has started.'),actions:[TextButton(onPressed:()=>Navigator.pop(ctx,false),child:const Text('Cancel')),FilledButton(onPressed:()=>Navigator.pop(ctx,true),child:const Text('Apply coupon'))]));
    if(confirmed!=true||!mounted)return;
    setState((){busy=true;notice='';});
    try{final result=await Api.post('mobile/rides/${widget.rideId}/apply-coupon',{'previewId':preview!['previewId']});if(mounted)setState((){applied=result['applied']==true;notice=result['notice']?.toString()??'Coupon applied to pending payment.';});}
    catch(e){if(mounted)setState(()=>notice='Coupon could not be applied: $e');}
    finally{if(mounted)setState(()=>busy=false);}
  }
  String rupees(dynamic paise)=>paise is num?'₹${(paise/100).toStringAsFixed(2)}':'—';
  @override Widget build(BuildContext context)=>Scaffold(appBar:AppBar(title:const Text('Coupon preview')),body:ListView(padding:const EdgeInsets.all(20),children:[SectionCard(child:Column(crossAxisAlignment:CrossAxisAlignment.start,children:[const Text('Check a coupon',style:TextStyle(fontSize:20,fontWeight:FontWeight.bold)),const SizedBox(height:12),TextField(controller:code,onChanged:(_)=>setState((){}),textCapitalization:TextCapitalization.characters,maxLength:24,decoration:const InputDecoration(labelText:'Coupon code',border:OutlineInputBorder())),FilledButton(onPressed:busy||code.text.trim().isEmpty?null:check,child:Text(busy?'Checking…':'Preview discount')),const SizedBox(height:10),const Text('A preview does not apply a coupon or change your payment amount.',style:TextStyle(color:Colors.deepOrange)),if(preview!=null)...[const Divider(),Text('Original fare: ${rupees(preview!['basePaise'])}'),Text('Estimated discount: ${rupees(preview!['discountPaise'])}'),Text('Preview total: ${rupees(preview!['quotedPaise'])}',style:const TextStyle(fontWeight:FontWeight.bold)),Text('Expires: ${preview!['expiresAt']}'),Text(applied?'APPLIED to pending online payment — not charged.':'NOT APPLIED — checkout remains unchanged.',style:TextStyle(color:applied?Colors.green:Colors.deepOrange,fontWeight:FontWeight.bold)),const SizedBox(height:10),FilledButton(onPressed:busy||applied||preview!['previewId']==null?null:apply,child:Text(applied?'Coupon applied':'Apply to pending payment'))],if(notice.isNotEmpty)Text(notice)]))]));
}
class RideTipScreen extends StatefulWidget {
  final String rideId;
  const RideTipScreen({super.key,required this.rideId});
  @override State<RideTipScreen> createState()=>_RideTipScreenState();
}
class _RideTipScreenState extends State<RideTipScreen> {
  int amountPaise=0; bool busy=false; String notice=''; Map<String,dynamic>? existing;
  @override void initState(){super.initState();load();}
  Future<void> load() async {try{final result=await Api.get('mobile/rides/${widget.rideId}/tip-intent');if(mounted)setState(()=>existing=result['tip'] is Map?Map<String,dynamic>.from(result['tip']):null);}catch(e){if(mounted)setState(()=>notice='Tip status unavailable: $e');}}
  Future<void> save() async {
    final confirmed=await showDialog<bool>(context:context,builder:(ctx)=>AlertDialog(title:const Text('Record tip intent?'),content:Text('Record ₹${(amountPaise/100).toStringAsFixed(2)}? No payment will be collected and the driver will not receive a payout.'),actions:[TextButton(onPressed:()=>Navigator.pop(ctx,false),child:const Text('Back')),FilledButton(onPressed:()=>Navigator.pop(ctx,true),child:const Text('Record intent'))]));
    if(confirmed!=true)return;
    setState(()=>busy=true);
    try{final result=await Api.post('mobile/rides/${widget.rideId}/tip-intent',{'amountPaise':amountPaise});if(mounted)setState(()=>notice=result['notice']?.toString()??'Intent recorded; not charged.');await load();}
    catch(e){if(mounted)setState(()=>notice='Tip request unavailable: $e');}
    finally{if(mounted)setState(()=>busy=false);}
  }
  @override Widget build(BuildContext context)=>Scaffold(appBar:AppBar(title:const Text('Driver tip')),body:ListView(padding:const EdgeInsets.all(20),children:[SectionCard(child:Column(crossAxisAlignment:CrossAxisAlignment.start,children:[const Text('Post-trip tip',style:TextStyle(fontSize:20,fontWeight:FontWeight.bold)),const SizedBox(height:12),if(existing!=null)...[Text('Existing tip intent: ₹${((existing!['amountPaise'] as num)/100).toStringAsFixed(2)}'),Text('Status: ${existing!['status']}'),const Text('This is not a payment receipt.') ]else...[Wrap(spacing:8,children:[0,2000,5000,10000,20000].map((v)=>ChoiceChip(label:Text('₹${v~/100}'),selected:amountPaise==v,onSelected:busy?null:(_)=>setState(()=>amountPaise=v))).toList()),const SizedBox(height:12),FilledButton(onPressed:busy?null:save,child:Text(busy?'Saving…':'Record tip intent'))],const SizedBox(height:12),const Text('No charge is made. Tip collection and driver payout are not yet enabled.',style:TextStyle(color:Colors.deepOrange)),if(notice.isNotEmpty)Text(notice)]))]));
}
