// As explained in the text/video, I have used two microcontroller boards here for two separate builds, one an Arduino Nano, and the second, an ESP8266 NodeMCU. This sketch doesn't use Wi-Fi, so it runs on either.
// To run code on an Arduino Nano:
//   1. Use plain pin numbers for digital pins. The Nano has no "D5"/"D7" names, so the servo and the
//      DRV8833's IN1, IN2 and enable pins (D7, D5, D2, D6) become 7, 5, 2, 6 (or whichever pins you wire).
// However, A0 doesn't have to be changed.
//   2. Change Serial.begin(74880) to Serial.begin(9600) and set the Serial Monitor to match.
//      (74880 is the ESP8266's boot baud rate, so its startup messages stay readable.)
//   3. Redo the calibration (lookup table). Both ADCs read 0-1023, but the Nano has a full scale voltage 0-5 V and the NodeMCU only has 0-3.3 V, so the bin edges in ac_pot_trig_vals and the knob end-stops (ac_pot_max_heat_val, ac_pot_max_cold_val) will shift.

#include <Arduino.h>
#include <Servo.h>

#define servo_signal_pin D7  // The pin that sends the PWM signals to the servo.

// The following three pins are used to control the direction and activation/deactivation of a motor driver that controls the motorized knob
#define control_knob_motor_driver_in_1_pin D5
#define control_knob_motor_driver_in_2_pin D2
#define control_knob_motor_driver_enable_pin D6

#define pot_input_pin A0  // The pin that reads the potentiometer output voltage - Must be an ADC linkable pin.
long ac_control_knob_turn_timeout_ms = 15000;  // This is useful in case the motor is unable to turn the knob to the desired output due to some blockage
int current_pot_val;  // Stores the last received potentiometer value
int ac_pot_max_heat_val = 350;
int ac_pot_max_cold_val = 950;

// Below we implement a lookup-table type logic to 1) reduce effects of noise causing servo jitter, 2) workaround the non-linearity in my potentiometer.
// Note: If your potentiometer is a linear one, the following manual mapping would become equal spaced.
const int num_ac_steps = 11;  // The number of virtual detents/ levels of temperatures
int ac_pot_trig_vals[num_ac_steps + 1] = {1024, 930, 910, 890, 870, 850, 760, 670, 580, 490, 450, 0};  // AC detent bin edges for the potentiometer values.
int ac_servo_angle_vals[num_ac_steps] = {0, 18, 36, 54, 72, 90, 108, 126, 144, 162, 180};  // Corresponding servo angles
int ac_servo_step_delay_ms = 50;  // Adjusting this enables control over how quickly or slowly the servo will move to the target. Low delay values give quick response but also creates loud servo noise.
int ac_servo_angle = 0;  // The state variable maintaining the current servo angle.
Servo acServoObj;  // create servo object to control a servo


// Compares a character received via the serial input with presets to trigger a heating or cooling function
void handleSerialInputForACKnobControlSystem(char c){
    
    if (c == 'H') {
      Serial.println("Heating Car");
      heatCar();
    }
    else if (c == 'C') {          
      Serial.println("Cooling Car");
      coolCar();
    }  
}

// A function that will automatically turn the motorized potentiometer knob towards max heat position, and also actually heat the car by turning the servo.
void heatCar(){  
  enableACKnobMotorDriver();  // Enable the motor driver
  turnACKnobMotorClockwise();  // Turn the motor CW open loop
  
  // While the motor turns open loop, check the current position of the potentiometer. Stop the motor if the knob is at the max heat position
  long start_time = millis();
  while ((current_pot_val > ac_pot_max_heat_val) && ((millis() - start_time) < ac_control_knob_turn_timeout_ms)){
    current_pot_val = getACKnobPotValue();
    delay(1);
  }
  stopACKnobMotor();
  disableACKnobMotorDriver();
  if (current_pot_val > ac_pot_max_heat_val) {
    Serial.println("WARNING: heatCar() timed out before reaching target position.");
  }
}

// A function that will automatically turn the motorized potentiometer knob towards max cool position, and also actually cool the car by turning the servo.
void coolCar(){  
  enableACKnobMotorDriver();  // Enable the motor driver
  turnACKnobMotorCounterClockwise();  // Turn the motor CCW open loop

// While the motor turns open loop, check the current position of the potentiometer. Stop the motor if the knob is at the max cool position
  long start_time = millis();
  while ((current_pot_val < ac_pot_max_cold_val) && ((millis() - start_time) < ac_control_knob_turn_timeout_ms)){
    current_pot_val = getACKnobPotValue();
    delay(1);
  }
  stopACKnobMotor();
  disableACKnobMotorDriver();
  if (current_pot_val < ac_pot_max_cold_val) {
    Serial.println("WARNING: coolCar() timed out before reaching target position.");
  }
}

// Sets the motor driver's input pins to turn the motor clockwise
void turnACKnobMotorClockwise() {  
  digitalWrite(control_knob_motor_driver_in_1_pin, LOW);
  digitalWrite(control_knob_motor_driver_in_2_pin, HIGH);
}

// Sets the motor driver's input pins to turn the motor counter-clockwise
void turnACKnobMotorCounterClockwise() {  
  digitalWrite(control_knob_motor_driver_in_1_pin, HIGH);
  digitalWrite(control_knob_motor_driver_in_2_pin, LOW);
}

// Forcibly brakes the motor
void stopACKnobMotor(){  
  digitalWrite(control_knob_motor_driver_in_1_pin, HIGH);
  digitalWrite(control_knob_motor_driver_in_2_pin, HIGH);
}

// Powers down the motor driver
void disableACKnobMotorDriver(){
  digitalWrite(control_knob_motor_driver_enable_pin, LOW);
}

// Powers up the motor driver
void enableACKnobMotorDriver(){
  digitalWrite(control_knob_motor_driver_enable_pin, HIGH);
}

// Method to poll, average, and extract the potentiometer reading.
int getACKnobPotValue(){
  // Averages over num_reps number of repeated measurements
  int num_reps = 10;
  current_pot_val = 0;
  for (int i=0; i<num_reps; i++){
    current_pot_val += analogRead(pot_input_pin);
    delayMicroseconds(10);
  }
  current_pot_val /= num_reps;
  return current_pot_val;
}

// This method goes through the lookup table to determine which bin the potentiometer value lands, and returns the corresponding servo angle.
int getServoAngleBasedOnPotVal(){
  current_pot_val = getACKnobPotValue();
  for (int i=0; i<num_ac_steps; i++){
    if ((current_pot_val<ac_pot_trig_vals[i]) && (current_pot_val >= ac_pot_trig_vals[i+1])){
      ac_servo_angle = ac_servo_angle_vals[i];
      break;  // Once the right bin is found, break, and return the corresponding servo angle      
    }
  }
  return ac_servo_angle;
}


// The complete pipeline that polls the potentiometer value, obtains the corresponding servo angle, and moves the servo to that desired position.
void updateServoPosition() {

  int current_ac_servo_angle = ac_servo_angle;
  int target_ac_servo_angle = getServoAngleBasedOnPotVal();
    
  if (current_ac_servo_angle < target_ac_servo_angle) {
    for (int pos = current_ac_servo_angle; pos <= target_ac_servo_angle; pos++) {
      acServoObj.write(pos);
      delay(ac_servo_step_delay_ms);   // smaller = smoother & faster
    }
  } 
  else {
    for (int pos = current_ac_servo_angle; pos >= target_ac_servo_angle; pos--) {
      acServoObj.write(pos);
      delay(ac_servo_step_delay_ms);
    }
  } 
  
  Serial.print("Current pot val: ");
  Serial.print(current_pot_val);
  Serial.print(", Current ac servo angle: ");
  Serial.println(ac_servo_angle);
}

// Method that listens to the Serial port to manually force the AC servo to update its position upon receiving the character 'S'
void handleSerialInputForACServo(char c){    
    if (c == 'S') {
      Serial.println("Updating servo position");
      updateServoPosition();
    }
}


void setupServoAndControlKnobSystem(){
  acServoObj.attach(servo_signal_pin);

  pinMode(pot_input_pin, INPUT);

  // Setup the motor driver pins
  pinMode(control_knob_motor_driver_in_1_pin, OUTPUT);
  pinMode(control_knob_motor_driver_in_2_pin, OUTPUT);
  pinMode(control_knob_motor_driver_enable_pin, OUTPUT);

  // At the start, turn the motor driver off as we don't want it to turn blindly as the arduino starts up.
  digitalWrite(control_knob_motor_driver_enable_pin, LOW);

  Serial.println("Servo and control knob system initialized.");
}

void setup() {
  Serial.begin(74880);
  setupServoAndControlKnobSystem();  
}

void loop() {
  
  // Constantly poll for new data that arrive via the serial input and call the appropriate functions.
  if (Serial.available() > 0) {
    char c = Serial.read();
    Serial.print("Received Serial Code ");
    Serial.println(c);
    handleSerialInputForACKnobControlSystem(c);
    handleSerialInputForACServo(c);
  }

  // Poll the potentiometer and update the servo position accordingly.
  updateServoPosition();

  delay(100);

}