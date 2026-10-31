// "Alexa, Start My Car" - Voice-controlled remote start for a 2003 Mitsubishi Lancer
// NodeMCU (ESP8266) + hacked Banvie 1 remote start system + Sinric Pro + Amazon Alexa
// Kasun Pathirage / Dumbledore's Navy - https://www.youtube.com/@DumbledoresNavy
//
// Before uploading: fill in your own Sinric Pro App Key/Secret, the three device IDs,
// and your Wi-Fi (or mobile hotspot) credentials below. Board: NodeMCU 0.9 (ESP-12).
// Library: "SinricPro" (Arduino IDE > Sketch > Include Library > Manage Libraries).
// Also turn OFF "Restore Device State When Connect" for every device on the Sinric Pro portal.

#include <Arduino.h>
#include <ESP8266WiFi.h>
#include <SinricPro.h>  // The main SinricPro library

// The libraries corresponding to the individual SinricPro Devices that we plan to use.
#include "SinricProSwitch.h"
#include "SinricProLock.h"
#include "SinricProGarageDoor.h"

////////////////////////////////////////////////////////////////////////////
// SINRICPRO VARIABLES

#define APP_KEY "YOUR-APP-KEY"  // Sinric Pro portal > Credentials > New App Key and Secret
#define APP_SECRET "YOUR-APP-SECRET"

// Each device on Sinric Pro needs a unique ID.
// This way Alexa, the Sinric Pro cloud backend, and the microcontroller know which device a message was intended to.
#define CAR_ENGINE_ID "YOUR-ENGINE-SWITCH-DEVICE-ID"
#define CAR_LOCK_ID "YOUR-LOCK-DEVICE-ID"
#define CAR_TRUNK_ID "YOUR-GARAGE-DOOR-DEVICE-ID"

////////////////////////////////////////////////////////////////////////////
// BANVIE SYSTEM CONTROL VARIABLES
#define banvie_pin D1

volatile long startTime = 0;
const int num_positive_pulses = 25; // 25 positive pulse edges because we want 24 pull downs.
const int num_repeats_per_train = 10;
const int trunk_release_key_press_hold_time_s = 4;

const uint16_t period_us = 1500; 
const uint16_t long_pulse_length_us = 1200;
const uint16_t short_pulse_length_us = period_us - long_pulse_length_us;
const int car_start_step_delay_ms = 500;

bool lockPulseWidths[num_positive_pulses] = {1,0,0,1,0,0,1,1,0,0,1,0,1,0,0,0,0,0,0,0,0,0,0,1,0};  // Lock sequence
bool mutedLockPulseWidths[num_positive_pulses] = {1,0,0,1,0,0,1,1,0,0,1,0,1,0,0,0,0,0,0,0,0,1,0,0,0};  // Muted Lock sequence
bool unlockPulseWidths[num_positive_pulses] = {1,0,0,1,0,0,1,1,0,0,1,0,1,0,0,0,0,0,0,0,0,0,1,0,0};  // Unlock sequence
bool trunkReleasePulseWidths[num_positive_pulses] = {1,0,0,1,0,0,1,1,0,0,1,0,1,0,0,0,0,0,0,0,1,1,0,0,0};  // Trunk release sequence

////////////////////////////////////////////////////////////////////////////
// WIFI SSID AND PASSWORSD
#define WIFI_SSID "YOUR-WIFI-OR-HOTSPOT-SSID"
#define WIFI_PASS "YOUR-WIFI-OR-HOTSPOT-PASSWORD"

////////////////////////////////////////////////////////////////////////////
// BANVIE SYSTEM CONTROL FUNCTIONS

void issuePulses(bool pulseWidths[], int num_positive_pulses){
  pinMode(banvie_pin, OUTPUT);
  digitalWrite(banvie_pin, LOW);

  for (int r = 0; r < num_repeats_per_train; r++){
    for (int i = 0; i < num_positive_pulses; i++) {
      
      uint16_t highTime = pulseWidths[i] == 1? long_pulse_length_us: short_pulse_length_us;
      uint16_t lowTime = pulseWidths[i] == 1? short_pulse_length_us: long_pulse_length_us;

      // HIGH portion
      digitalWrite(banvie_pin, HIGH);
      startTime = micros();
      while ((micros() - startTime) < highTime){};
      

      // LOW portion
      digitalWrite(banvie_pin, LOW);
      startTime = micros();
      while ((micros() - startTime) < lowTime){};   
    }
    
    delay(12);  // gap between trains
  }
  pinMode(banvie_pin, INPUT);
  
}

void lockCar(){
  Serial.println("Locking car");
  issuePulses(lockPulseWidths, num_positive_pulses);  
}

void mutedLockCar(){
  Serial.println("Muted Lock Activated");
  issuePulses(mutedLockPulseWidths, num_positive_pulses);
}

void unlockCar(){
  Serial.println("Unlocking Car");
  issuePulses(unlockPulseWidths, num_positive_pulses);
}

void releaseTrunk(){
  Serial.println("Releasing Trunk Door");      
  long trunk_start_time = millis();
  while ((millis() - trunk_start_time) < (trunk_release_key_press_hold_time_s * 1000)){
    issuePulses(trunkReleasePulseWidths, num_positive_pulses);
  }      
}

void startEngine(){
  Serial.println("Starting car");
  issuePulses(lockPulseWidths, num_positive_pulses);
  delay(car_start_step_delay_ms);
  issuePulses(unlockPulseWidths, num_positive_pulses);
  delay(car_start_step_delay_ms);
  issuePulses(unlockPulseWidths, num_positive_pulses);
  delay(car_start_step_delay_ms);
  issuePulses(unlockPulseWidths, num_positive_pulses);
  delay(car_start_step_delay_ms);
}

void stopEngine(){
  Serial.println("Stopping car");
  issuePulses(unlockPulseWidths, num_positive_pulses);
  delay(car_start_step_delay_ms);
  issuePulses(unlockPulseWidths, num_positive_pulses);
  delay(car_start_step_delay_ms);
  issuePulses(unlockPulseWidths, num_positive_pulses);
  delay(car_start_step_delay_ms);
}

void handleSerialInputForBanvieSystem(char c){
    
    if (c == 'L') {
      lockCar();
    }
    else if (c == 'T') {          
      releaseTrunk();
    }
    else if (c == 'U') {
      unlockCar();
    }
    else if (c == 'M') {
      mutedLockCar();
    }
}

////////////////////////////////////////////////////////////////////////////
// WIFI AND ALEXA CONTROL FUNCTIONS

// Each callback function below receives two inputs, first, a deviceID, and the state of the device depending on the command the callback was linked to.
// We do not need to worry about the deviceID because each callback only handles state changes from one device. That is, we have a one to one mapping between each callback function and device.
// After every successful callback, the bool TRUE must be returned so that the cloud back end knows that the request was handled, and conveys that to Alexa too.

bool onPowerStateCarEngineSwitch(const String &deviceId, bool &state) {
  // The car engine was configured as a switch device, and this callback was attached to the SinricPro's 'onPowerState' method for the SinricProSwitch devices.
  // When the power state of the switch flips, this method is called.
  // If the switch is ON, the state will be True, and if it is OFF, it will be False.
  Serial.println("Device " + String(deviceId.c_str()) + " is " + (state?"on":"off"));

  // If the switch power state is ON, trigger the startEngine sequence.
  if (state) {
    startEngine();
    return true;
  }
  else{  // If the switch power state is OFF, trigger the stopEngine sequence
    stopEngine();
    return true;
  }
}

bool onLockStateCarLock(const String &deviceId, bool &state) {
  // The car lock was configured as a generic smart lock device, and this callback was attached to the SinricPro's 'onLockState' method for the SinricProLock devices.
  // When the lock state toggles, this method is called.
  // If the command requests the lock to be locked, the state will be True, and if it is to be unlocked, the state will be False.

  Serial.println("Device " + String(deviceId.c_str()) + " is " + (state?"locked":"unlocked"));
  
  // Based on the state, trigger either the locking or unlocking sequences.
  // Return true once done. 
  if (state){
    lockCar();  
  }
  else{
    unlockCar();
  }  
  return true;
}

bool onDoorStateCarTrunk(const String &deviceId, bool &state) {
  // The car trunk door was configured as a garage door device, and this callback was attached to the SinricPro's 'onDoorState' method for the SinricProGarageDoor devices.
  // When the door state toggles, this method is called.
  // If the command requests the door to be CLOSED, the state will be True, and if it is to be OPENED, the state will be False.

  Serial.println("Device " + String(deviceId.c_str()) + " is " + (state?"closed":"open"));
  
  // The following portion executes if state is FALSE.
  if (!state){
    releaseTrunk();  
  }
  // I did not retrofit a mechanism for the trunk closing, hence we don't have the need for the TRUE state.
  
  return true;
}

////////////////////////////////////////////////////////////////////////////

void setupWiFi(){ // setup function for WiFi connection
  Serial.println("Wifi is Connecting...");
  
  WiFi.setSleepMode(WIFI_NONE_SLEEP);  // Do not let the wifi system sleep. 
  WiFi.setAutoReconnect(true);  // If wifi drops, it will auto-reconnect.  
  WiFi.begin(WIFI_SSID, WIFI_PASS);  // Use the specified SSID and password to establish internet connection. If you need to use this anywhere, use a mobile hotspot connection here. 
  
  // Print a stream of dots until wifi connectivity is established.
  while (WiFi.status() != WL_CONNECTED) {
    Serial.println(".");
    delay(250);
  }

  IPAddress localIP = WiFi.localIP();
  Serial.println("connected!");
  Serial.println("WiFi: IP-Address is" + String(localIP[0]) + "." + String(localIP[1]) + "." + String(localIP[2]) + "." + String(localIP[3]));
}

void setupSinricPro(){
  // Create a Sinric Pro virtual device for every function.
  // Select devices that natively support the intended voice commands.
  // Note, on the Alexa interface (inside the Alexa app), you can name each of these devices with a custom name, like 'My Car Engine', 'My Car Trunk', etc. 
  SinricProSwitch &carEngineSwitch = SinricPro[CAR_ENGINE_ID];  // The car engine start/stop is configured as a Switch device. Name the object carEngineSwitch.
  SinricProLock &carLock = SinricPro[CAR_LOCK_ID];  // The car lock/unlock is configured as a generic Lock device. Name the object carLock.
  SinricProGarageDoor &carTrunkDoor = SinricPro[CAR_TRUNK_ID];   // The trunk door is configured as a GarageDoor device. Name the object carTrunkDoor.

  // Each SinricPro device type has a set of commands it recognizes and responds to.
  // Attach callbacks to appropriate commands.
  carEngineSwitch.onPowerState(onPowerStateCarEngineSwitch);  // Attach the callback 'onPowerStateCarEngineSwitch' to be triggered when the carEngineSwitch is switched ON or OFF (Power state).
  carLock.onLockState(onLockStateCarLock);  // Attach the callback 'onLockStateCarLock' to be triggered when the carLock is locked or unlocked.
  carTrunkDoor.onDoorState(onDoorStateCarTrunk);  // Attach the callback 'onDoorStateCarTrunk' to be triggered when the carTrunkDoor is opened or closed.
  
  // For debugging purposes, notify everytime the SinricPro Library running on the microcontroller establishes/loses connection (via wifi) with the cloud backend.
  SinricPro.onConnected([](){Serial.println("Connected to SinricPro");});
  SinricPro.onDisconnected([](){Serial.println("Disconnected from SinricPro");});
  
  // This is important - If this is set to True, if the connection to the cloud backend is re-established after a drop, the last used state will be restored.
  // For example, if you last asked the car to start, the start car command will be re-issued. 
  // Despite setting this in code, I found that I also had to make sure the setting "Restore Device State When Connect" on the Sinric Pro web portal was set to False  
  SinricPro.restoreDeviceStates(false);

  // Here we setup the secure connection between the cloud backend and the microcontroller.
  SinricPro.begin(APP_KEY, APP_SECRET);
}

void setupBanvieSystem(){
    pinMode(banvie_pin, INPUT); // This should be set to floating whenever we do NOT issue any command so that the normal remote can also work.
    Serial.println("Banvie system initialized.");
    Serial.println("Press 'L', 'T', 'U', 'M' for 'Lock', 'Trunk release', 'Unlock', and 'Muted Lock' respectively.");
}


void setup() {
  Serial.begin(74880);
  setupWiFi();  
  setupSinricPro();
  setupBanvieSystem();
}

void loop() {
  
  // If a message is received via Serial Input (during debugging), trigger the appropriate command.
  if (Serial.available() > 0) {
    char c = Serial.read();
    Serial.println("Received Serial Code " + String(c));
    handleSerialInputForBanvieSystem(c);
  }

  SinricPro.handle();  // Constantly listens to any messages the cloud backend may send.

  delay(100);

}