// As explained in the text/video, I have used two microcontroller boards here for two separate builds, one an Arduino Nano, and the second, an ESP8266 NodeMCU.
// To run code on an Arduino Nano:
//   1. Use plain pin numbers for digital pins. The Nano has no "D7" name, so write
//      #define servo_signal_pin 7 (or whichever pin the servo is on).
// However, A0 doesn't have to be changed.
//   2. Change Serial.begin(74880) to Serial.begin(9600) and set the Serial Monitor to match.
//      (74880 is the ESP8266's boot baud rate, so its startup messages stay readable.)
//   3. Redo the calibration (lookup table). Both ADCs read 0-1023, but the Nano has a full scale voltage 0-5 V and the NodeMCU only has 0-3.3 V, so the bin edges in ac_pot_trig_vals will shift.

#include <Arduino.h>
#include <Servo.h>

#define servo_signal_pin D7  // The pin that sends the PWM signals to the servo.

#define pot_input_pin A0  // The pin that reads the potentiometer output voltage - Must be an ADC linkable pin.

int current_pot_val;  // Stores the last received potentiometer value

// Below we implement a lookup-table type logic to 1) reduce effects of noise causing servo jitter, 2) workaround the non-linearity in my potentiometer.
// Note: If your potentiometer is a linear one, the following manual mapping would become equal spaced.
const int num_ac_steps = 11;  // The number of virtual detents/ levels of temperatures
int ac_pot_trig_vals[num_ac_steps + 1] = {1024, 930, 910, 890, 870, 850, 760, 670, 580, 490, 450, 0};  // AC detent bin edges for the potentiometer values.
int ac_servo_angle_vals[num_ac_steps] = {0, 18, 36, 54, 72, 90, 108, 126, 144, 162, 180};  // Corresponding servo angles
int ac_servo_step_delay_ms = 50;  // Adjusting this enables control over how quickly or slowly the servo will move to the target. Low delay values give quick response but also creates loud servo noise.
int ac_servo_angle = 0;  // The state variable maintaining the current servo angle.
Servo acServoObj;  // create servo object to control a servo

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

void setupServoSystem(){
  acServoObj.attach(servo_signal_pin);
  pinMode(pot_input_pin, INPUT);
  Serial.println("Servo system initialized.");
}

void setup() {
  Serial.begin(74880);
  setupServoSystem();  
}

void loop() {

  updateServoPosition();

  delay(100);

}