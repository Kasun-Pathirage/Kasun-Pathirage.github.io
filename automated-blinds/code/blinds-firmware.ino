/*
  Automated window blind: ESP8266 (NodeMCU) + IBT-4 H-bridge + car power window motor.
  Alexa control through the Sinric Pro "Blinds" device type.

  - "Open" / "close" runs the motor up or down. Partial positions are not supported.
  - "Turn off" stops the motor.
  - A voice-triggered move stops when the matching limit switch trips, when either
    manual button is pressed, or after maxRunTimeInMS, whichever comes first.
  - Two manual buttons drive the blind up or down while held, but never past a limit switch.
  - Limit switches and buttons use the internal pull-ups and are active LOW (switch to GND).

  Work in progress: this is a working prototype, not finished or fine-tuned firmware.

  Fill in your own Wi-Fi and Sinric Pro credentials before flashing.
*/

#include <Arduino.h>
#include <ESP8266WiFi.h>
#include <SinricPro.h>
#include <SinricProBlinds.h>

#define WIFI_SSID "YOUR_WIFI_SSID"
#define WIFI_PASS "YOUR_WIFI_PASSWORD"

#define APP_KEY "YOUR_SINRIC_APP_KEY"
#define APP_SECRET "YOUR_SINRIC_APP_SECRET"
#define BLINDS_ID "YOUR_SINRIC_DEVICE_ID"

#define BAUD_RATE 115200

#define MOTOR_DRIVER_IN1 D0
#define MOTOR_DRIVER_IN2 D1
#define MOTOR_DRIVER_EN D2

// Limit switches can be held closed at power-up (blind fully up or down), so they sit on
// pins with no boot-mode role. D3 (GPIO0) must be HIGH at boot, which is fine for a
// momentary button that is only pressed after the board is running.
#define UPPER_LIMIT_SWITCH D5   // GPIO14
#define LOWER_LIMIT_SWITCH D6   // GPIO12

#define MANUAL_DRIVE_UP D7      // GPIO13
#define MANUAL_DRIVE_DOWN D3    // GPIO0

int blindsPosition = 0;
int blindsFullyOpenPosition = 100;
int blindsFullyClosedPosition = 0;

bool powerState = false;

int currentDirection = 0; // -1 is downwards, 0 is stopped, 1 is upwards.
volatile bool manualDriveUp = false;
volatile bool manualDriveDown = false;

volatile bool lowerLimitSwitchTriggered = false;
volatile bool upperLimitSwitchTriggered = false;

volatile unsigned long lastDebounceTime = 0;
volatile unsigned long debounceDelay = 50;  // ms

const int pollEveryMS = 100;  // Poll limit switches every this number of ms during blinds motion.
const int maxRunTimeInMS = 4000; // How long the motor will stay on in automatic mode before automatically stopping.

void debounce(){
  lastDebounceTime = millis();
  while ((millis() - lastDebounceTime) < debounceDelay){}
}

////////////////////////////////////////////////

void IRAM_ATTR handleUpperLimitSwitchInterrupt(){

  debounce();

  if (digitalRead(UPPER_LIMIT_SWITCH) == 0){
    upperLimitSwitchTriggered = true;
  }
  else{
    upperLimitSwitchTriggered = false;
  }
}

void IRAM_ATTR handleLowerLimitSwitchInterrupt(){

  debounce();

  if (digitalRead(LOWER_LIMIT_SWITCH) == 0){
    lowerLimitSwitchTriggered = true;
  }
  else{
    lowerLimitSwitchTriggered = false;
  }
}

////////////////////////////////////////////////

void IRAM_ATTR handleManualDriveDownInterrupt(){

  debounce();

  if (digitalRead(MANUAL_DRIVE_DOWN) == 0){
    manualDriveDown = true;
  }
  else{
    manualDriveDown = false;
  }
}

void IRAM_ATTR handleManualDriveUpInterrupt(){

  debounce();

  if (digitalRead(MANUAL_DRIVE_UP) == 0){
    manualDriveUp = true;
  }
  else{
    manualDriveUp = false;
  }
}

////////////////////////////////////////////////

void stopMotor() {
  currentDirection = 0;
  digitalWrite(MOTOR_DRIVER_IN1, LOW);
  digitalWrite(MOTOR_DRIVER_IN2, LOW);
  digitalWrite(MOTOR_DRIVER_EN, HIGH);
}

void motorBlindsUp(){
    currentDirection = 1;
    digitalWrite(MOTOR_DRIVER_IN1, HIGH);
    digitalWrite(MOTOR_DRIVER_IN2, LOW);
    digitalWrite(MOTOR_DRIVER_EN, LOW);
}

void motorBlindsDown(){
    currentDirection = -1;
    digitalWrite(MOTOR_DRIVER_IN1, LOW);
    digitalWrite(MOTOR_DRIVER_IN2, HIGH);
    digitalWrite(MOTOR_DRIVER_EN, LOW);
}

////////////////////////////////////////////////

bool onPowerState(const String &deviceId, bool &state) {
  Serial.printf("Device %s power turned %s \r\n", deviceId.c_str(), state ? "on" : "off");
  powerState = state;
  if (powerState == false) {
    stopMotor();
  }

  return true;  // request handled properly
}

bool onRangeValue(const String &deviceId, int &position) {
  // Called for "open the blinds" / "close the blinds".
  Serial.printf("Device %s set position to %d\r\n", deviceId.c_str(), position);

  if (position == blindsFullyOpenPosition) {
    motorBlindsUp();
  }

  else if (position == blindsFullyClosedPosition) {
    motorBlindsDown();
  }

  unsigned long startTimeInMS = millis();

  while ((millis() - startTimeInMS) < maxRunTimeInMS) {

    bool manualOverride = manualDriveDown || manualDriveUp;
    bool limitSwitchLimited = (upperLimitSwitchTriggered && (currentDirection == 1)) || (lowerLimitSwitchTriggered && (currentDirection == -1));

    if (manualOverride || limitSwitchLimited){
      break;
    }

    SinricPro.handle();
    delay(pollEveryMS);

  }

  stopMotor();
  return true;  // request handled properly
}

bool onAdjustRangeValue(const String &deviceId, int &positionDelta) {
  blindsPosition += positionDelta;
  Serial.printf("Device %s position changed about %i to %d\r\n", deviceId.c_str(), positionDelta, blindsPosition);
  positionDelta = blindsPosition;  // calculate and return absolute position
  if (positionDelta > 0) {
    onRangeValue(BLINDS_ID, blindsFullyOpenPosition);
  }
  else {
    onRangeValue(BLINDS_ID, blindsFullyClosedPosition);
  }
  return true;  // request handled properly
}

////////////////////////////////////////////////

void setupWiFi(){ // setup function for WiFi connection
  Serial.printf("\r\n[Wifi]: Connecting");
  WiFi.setSleepMode(WIFI_NONE_SLEEP);
  WiFi.setAutoReconnect(true);
  WiFi.begin(WIFI_SSID, WIFI_PASS);
  while (WiFi.status() != WL_CONNECTED) {
    Serial.printf(".");
    delay(250);
  }

  IPAddress localIP = WiFi.localIP();
  Serial.printf("connected!\r\n[WiFi]: IP-Address is %d.%d.%d.%d\r\n", localIP[0], localIP[1], localIP[2], localIP[3]);
}

void setupSinricPro() {
  // get a new Blinds device from SinricPro
  SinricProBlinds &myBlinds = SinricPro[BLINDS_ID];
  myBlinds.onPowerState(onPowerState);
  myBlinds.onRangeValue(onRangeValue);
  myBlinds.onAdjustRangeValue(onAdjustRangeValue);

  // setup SinricPro
  SinricPro.onConnected([](){Serial.printf("Connected to SinricPro\r\n");});
  SinricPro.onDisconnected([](){Serial.printf("Disconnected from SinricPro\r\n");});

  SinricPro.begin(APP_KEY, APP_SECRET);
}

void setupMotorControl() {
  pinMode(MOTOR_DRIVER_IN1, OUTPUT);
  pinMode(MOTOR_DRIVER_IN2, OUTPUT);
  pinMode(MOTOR_DRIVER_EN, OUTPUT);
  digitalWrite(MOTOR_DRIVER_IN1, LOW);
  digitalWrite(MOTOR_DRIVER_IN2, LOW);
  digitalWrite(MOTOR_DRIVER_EN, HIGH);
}

void setupLimitSwitches() {
  pinMode(UPPER_LIMIT_SWITCH, INPUT_PULLUP);
  pinMode(LOWER_LIMIT_SWITCH, INPUT_PULLUP);
  attachInterrupt(digitalPinToInterrupt(UPPER_LIMIT_SWITCH), handleUpperLimitSwitchInterrupt, CHANGE);
  attachInterrupt(digitalPinToInterrupt(LOWER_LIMIT_SWITCH), handleLowerLimitSwitchInterrupt, CHANGE);
}

void setupManualDrive() {
  pinMode(MANUAL_DRIVE_DOWN, INPUT_PULLUP);
  pinMode(MANUAL_DRIVE_UP, INPUT_PULLUP);
  attachInterrupt(digitalPinToInterrupt(MANUAL_DRIVE_DOWN), handleManualDriveDownInterrupt, CHANGE);
  attachInterrupt(digitalPinToInterrupt(MANUAL_DRIVE_UP), handleManualDriveUpInterrupt, CHANGE);
}

////////////////////////////////////////////////

void manualDrive(){

  if (manualDriveUp && upperLimitSwitchTriggered == false){
    motorBlindsUp();
  }
  else if (manualDriveDown && lowerLimitSwitchTriggered == false) {
    motorBlindsDown();
  }
  else{
    stopMotor();
  }

}

////////////////////////////////////////////////

// main setup function
void setup() {
  Serial.begin(BAUD_RATE);
  setupLimitSwitches();
  setupMotorControl();
  setupManualDrive();
  setupWiFi();
  setupSinricPro();
}

void loop() {
  SinricPro.handle();
  manualDrive();
}
